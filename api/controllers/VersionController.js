/**
 * VersionController
 *
 * @description :: Server-side logic for handling version requests
 * @help        :: See http://sailsjs.org/#!/documentation/concepts/Controllers
 */

var actionUtil = require('sails/lib/hooks/blueprints/actionUtil');
var url = require('url');
var Promise = require('bluebird');

module.exports = {

  /**
   * Redirect the update request to the appropriate endpoint
   * (GET /update)
   */
  redirect: function(req, res) {
    var platform = req.param('platform');
    var version = req.param('version');

    if (!version) {
      return res.badRequest('Requires "version" parameter');
    }
    if (!platform) {
      return res.badRequest('Requires "platform" parameter');
    }

    return res.redirect('/update/' + platform + '/' + version);
  },

  /**
   * Serves auto-updates: Status and Squirrel.Mac
   *
   * Assumes stable channel unless specified
   *
   * (GET /update/:platform/:version/:channel)
   */
  general: function(req, res) {
    var platform = req.param('platform');
    var version = req.param('version');
    var channel = req.param('channel') || 'stable';

    if (!version) {
      return res.badRequest('Requires `version` parameter');
    }

    if (!platform) {
      return res.badRequest('Requires `platform` parameter');
    }

    var platforms = PlatformService.detect(platform);

    sails.log.debug('Update Search Query', {
      platform: platforms,
      version: version,
      channel: channel
    });

    // Get specified version object, it's time will be used for the general
    // cutoff.
    Version
      .findOne(version)
      .then(function(currentVersion) {

        var createdAtFilter;

        if (_.isObject(currentVersion)) {
          createdAtFilter = {
            '>': currentVersion.createdAt
          };
        }

        sails.log.debug('Time Filter', createdAtFilter);

        return Version
          .find(UtilityService.getTruthyObject({
            channel: channel,
            createdAt: createdAtFilter
          }))
          .sort({ createdAt: 'desc' })
          .populate('assets', {
            platform: platforms
          })
          .then(function(newerVersions) {
            var latestVersion;
            sails.log.debug('Newer Versions', newerVersions);

            var releaseNotes = _.reduce(
              newerVersions,
              function(prevNotes, newVersion) {

                newVersion.assets = _.filter(newVersion.assets, function (asset) {
                  return asset.filetype === '.zip';
                });

                // If one of the assets for this verison apply to our desired
                // platform then we will skip this version
                if (!newVersion.assets.length) {
                  return prevNotes;
                }

                if (!latestVersion) {
                  latestVersion = newVersion;
                }

                // Skip if no notes available for this version
                if (!newVersion.notes || !newVersion.notes.length) {
                  return prevNotes;
                }

                // If not the first changenote, prefix with new line
                var newChangeNote = !prevNotes.length ? '' : '\n';

                newChangeNote += '## ' + newVersion.name + '\n' + newVersion.notes;

                return prevNotes + newChangeNote;
              },
              '');

            if (!latestVersion || latestVersion.name === version) {
              return res.status(204).send('No updates.');
            }

            console.log('Latest Version', latestVersion);

            return res.ok({
              url: url.resolve(
                sails.config.appUrl,
                '/download/version/' + latestVersion.name +
                '/' + latestVersion.assets[0].platform + '?filetype=zip'
              ),
              name: latestVersion.name,
              notes: releaseNotes,
              pub_date: latestVersion.createdAt.toISOString()
            });
          });
      })
      .catch(res.negotiate);
  },

  /**
   * Serves auto-updates: Squirrel.Windows: serve RELEASES from latest version
   * Currently, it will only serve a full.nupkg of the latest release with a
   * normalized filename (for pre-release)
   *
   * (GET /update/:platform/:version/:channel/RELEASES)
   */
  windows: function(req, res) {
    var platform = req.param('platform');
    var version = req.param('version');
    var channel = req.param('channel') || 'stable';

    if (!version) {
      return res.badRequest('Requires `version` parameter');
    }

    if (!platform) {
      return res.badRequest('Requires `platform` parameter');
    }

    var platforms = PlatformService.detect(platform);

    sails.log.debug('Windows Update Search Query', {
      platform: platforms,
      version: version,
      channel: channel
    });

    // Get specified version object, it's time will be used for the general
    // cutoff.
    Version
      .findOne(version)
      .then(function(currentVersion) {
        if (!currentVersion) {
          return res.notFound('The specified `version` does not exist');
        }

        return Version
          .find(UtilityService.getTruthyObject({
            channel: channel,
            createdAt: {
              '>=': currentVersion.createdAt
            }
          }))
          .populate('assets', {
            platform: platforms
          })
          .then(function(newerVersions) {
            var latestVersion = _.find(
              newerVersions,
              function(newVersion) {
                return newVersion.assets.length;
              });

            if (!latestVersion) {
              return res.status(404).send('No updates.');
            }

            // Change asset name to use full download link
            assets = _.map(latestVersion.assets, function(asset) {
              asset.name = url.resolve(sails.config.appUrl,
                '/download/' + latestVersion.name + '/' + asset.name);

              return asset;
            });

            var output = WindowsReleaseService.generate(assets);

            res.header('Content-Length', output.length);
            res.attachment('RELEASES');
            return res.send(output);
          });
      })
      .catch(res.negotiate);
  },

  /**
   * Get release notes for a specific version
   * (GET /notes/:version?)
   */
  releaseNotes: function(req, res) {
    var version = req.params.version;

    Version
      .findOne(version)
      .then(function(currentVersion) {
        if (!currentVersion) {
          return res.notFound('The specified version does not exist');
        }

        return res.format({
          'application/json': function() {
            res.send({
              'notes': currentVersion.notes,
              'pub_date': currentVersion.createdAt.toISOString()
            });
          },
          'default': function() {
            res.send(currentVersion.notes);
          }
        });
      })
      .catch(res.negotiate);
  },

  /**
   * Overloaded blueprint function
   * Changes:
   *  - Delete all associated assets & their files
   * @param  {[type]} req [description]
   * @param  {[type]} res [description]
   * @return {[type]}     [description]
   */
  destroy: function(req, res) {
    var pk = actionUtil.requirePk(req);

    var query = Version.findOne(pk);
    query.populate('assets');
    query.exec(function foundRecord(err, record) {
      if (err) return res.serverError(err);
      if (!record) return res.notFound('No record found with the specified `name`.');

      var deletePromises = _.map(record.assets, function(asset) {
        return Promise.join(
          AssetService.destroy(asset, req),
          AssetService.deleteFile(asset),
          function() {
            sails.log.info('Destroyed asset: ', asset);
          });
      });

      Promise.all(deletePromises)
        .then(function allDeleted() {
          return Version.destroy(pk)
            .then(function destroyedRecord() {

              if (sails.hooks.pubsub) {
                Version.publishDestroy(
                  pk, !req._sails.config.blueprints.mirror && req, {
                    previous: record
                  }
                );

                if (req.isSocket) {
                  Version.unsubscribe(req, record);
                  Version.retire(record);
                }
              }

              sails.log.info('Destroyed version: ', record);

              return res.ok(record);
            });
        })
        .error(res.negotiate);
    });
  }
};


(function (module) {

  "use strict";

  var async = require("async");
  var util = require("util");
  var fs = require("fs");
  var BaseCRUD = require("./base");
  var signals = require("../signals");

  function AttachmentCRUD (options) {
    BaseCRUD.call(this, options);

    this.deleteEnabled = true;

    this.modelClass = require("../../models/attachment");
    this.key = this.modelClass.modelName.toLowerCase();
  }

  util.inherits(AttachmentCRUD, BaseCRUD);

  AttachmentCRUD.prototype._create = function (data, callback) {
    var att = new this.modelClass(data)
      , name = '/' + this.key + ':create';
    var self = this;

    att.save(function (err, saveObject) {
      saveObject.populate('uploaderId', function (err, attachment) {
        if(!err){
          self.emitMessage(name, attachment);

          signals.post_create.send(attachment,
                                   {instance: attachment, socket: self.socket},
                                  function(err, result){});
        }
      });
    });
  };

  AttachmentCRUD.prototype._read = function (data, callback) {
    if (data) {
      if (data._id) {
        this.modelClass.findOne(data).populate('uploaderId').exec(
          function (err, result) {
            callback(err, result);
          }
        );
      } else {
        this.modelClass.find(data).populate('uploaderId').sort({'createdOn': 'asc'}).exec(
          function (err, result) {
            callback(err, result);
          }
        );
      }
    } else {
      this.modelClass.find({}).populate('uploaderId').sort({'createdOn': 'asc'}).exec(callback);
    }
  };

  AttachmentCRUD.prototype._delete = function (data, callback) {
    var self = this;

    if (data && data._id) {
      var name = '/' + this.key + '/' + data._id + ':delete';

      async.waterfall([
        function (callback) {
          self.isBoardMember(function(err, isMember) {
            callback(err, isMember);
          });
        },
        function (isMember, callback) {
          if(isMember){
            self.modelClass.findByIdAndRemove(data._id, function(err, removedObject) {
              callback(err, removedObject);
            });
          } else {
            callback('Error: you do not have permission to delete this attachment.', null);
          }
        },
        function (removedObject, callback) {
          fs.unlink(removedObject.path, function (err) {
            callback(err, removedObject);
          });
        }
      ], function (err, removedObject) {
        if (err) {
          callback(err, data);
        } else {
          self.emitMessage(name, removedObject);

          signals.post_delete.send(removedObject, 
                                   {instance: removedObject, socket: self.socket},
                                  function(err, result) {});
        }
      });
    }
  };

  module.exports = AttachmentCRUD;
})(module);

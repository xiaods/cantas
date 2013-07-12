(function (exports) {

  "use strict";

  var mongoose = require('mongoose')
    , connect = require('express/node_modules/connect')
    , parseCookie = connect.utils.parseCookie
    , Session = connect.middleware.session.Session
    , passport = require('passport')
    , crud = require('./crud')
    , io // To be set globally later.
    , Board = require("../models/board")
    , BoardMembership = require("./boardMembership")
    , BoardMove = require("./boardMove")
    , BoardMemberRelation = require("../models/boardMemberRelation")
    , Activity = require("../models/activity")
    , SocketPatch = require("./patch_socket");

  function Room (socket) {
    /**
     * Set an internal reference of the client socket.
     */
    this.socket = socket;
    // Only one board is supposed to be accessed in one connection
    this.board = null;
  }

  Room.prototype.boardIdToRoomName = function (boardId) {
    return ('board:' + boardId);
  }

  Room.prototype.joinBoard = function (boardId) {
    /**
     * Join a user to a room that represents a board.
     * Return a list of 'users' currently in this room.
     * 'users' should be a list of User instance,
     * but there should be some setup on connection
     */
    var roomName = this.boardIdToRoomName(boardId);
    this.socket.join(roomName);
    this.board = roomName;
    var members = io.sockets.clients(roomName);
    var userList = [];
    for (var index in members) {
      var member = members[index];
      userList.push(member.handshake.user.toJSON());
    }
    return userList;
  }

  Room.prototype.myRooms = function () {
    return io.sockets.manager.roomClients[this.socket.id];
  }

  /*
   * leave all room and return boardID list
   */
  Room.prototype.leaveAllRoom = function () {
    this.socket.room.emit('user-logout', {ok: 0, visitor: this.socket.handshake.user});
    var rooms = this.myRooms();

    for (var index in rooms) {
      this.socket.leave(rooms[index]);
    }
  }

  Room.prototype.crudAudiences = function () {
    /**
     * Return room names that a CRUD event should
     * be emitted into.
     */
    return this.board;
  }

  Room.prototype.emit = function (eventName, eventData, options) {
    /**
     * Call .emit for its socket.
     */
    if (options !== undefined && options.exceptMe)
      this.socket.broadcast.to(this.board).emit(eventName, eventData);
    else
      io.sockets.in(this.board).emit(eventName, eventData);
  }

  exports.Room = Room;

  exports.init = function (sio, sessionStore) {

    io = sio;

    // Authorization during handshake
    sio.set('authorization', function (data, callback) {
      // Without a cookie that holds the user's session id
      // the user can not be authorized
      if (!data.headers.cookie) {
        return callback('No cookie transmitted.', false);
      }

      data.cookie = parseCookie(data.headers.cookie);
      data.sessionID = data.cookie['express.sid'];

      /*
      Using the session id found in the cookie, find the
      session in Redis.  The authorization will fail if the
      session is not found.
      */
      sessionStore.load(data.sessionID, function (err, session) {
        if (err || !session) {
          return callback('Error', false);
        } else {
          /**
           * Deserialize a user instance from passport session
           * and set it onto handshake for later re-use.
           */
          var userKey = session.passport.user;
          passport.deserializeUser(userKey, function (err, user) {
            data['user'] = user;
            callback(null, true);
          });
        }
      });
    });

    sio.on('connection', function (socket) {
      // Let us patch socket first to add our custom and useful behaviors,
      // which will be used in the whole life of Cantas.
      SocketPatch.patch(socket);

      var hs = socket.handshake
        , sessionID = hs.sessionID;

      // Set up CRUD method for each model
      crud.setUp(socket, hs);

      /**
       * Set a room management instance for this client.
       */
      socket.room = new Room(socket);
      socket.sio = sio;


      /*
       * When a user joins a board, following steps have to be taken,
       * - validate whether board exists
       * - confirm a user's membership if current user is invited to the board
       *
       * Finally, join current user to board and notify client everything is okay.
       */
      socket.on('join-board', function (boardId) {
        var user = socket.handshake.user;

        Board.joinBoard(user, boardId, function(err, result){
          if(result.ok === 0) {
            BoardMemberRelation.getBoardMembers(result.board._id, function(err, members){
              members = members.map(function(member){
                return member.userId._id.toString();
              });
              var userList = socket.room.joinBoard(boardId);
              userList = userList.map(function(user){
                user.role = {'name': '', 'desc': ''};
                if(user._id.toString() === result.board.creatorId.toString()){
                  user.role.name = 'admin';
                  user.role.desc = 'Admin - full control';
                }else if(members.indexOf(user._id.toString()) != -1){
                  user.role.name = 'member';
                  user.role.desc = 'Member - full control';
                }else{
                  user.role.name = 'viewer';
                  user.role.desc = 'Viewer - view only';
                }
                return user;
              });

              // boardcasting visitor's activity status
              // FIXME: refactor the workflow of how to determine user's role of board
              userList.forEach(function(user){
                if(socket.handshake.user._id.toString() === user._id.toString()){
                  socket.room.emit('user-login:board:'+boardId, {ok: result.ok, visitor:user, boardId: boardId});
                }
              });

              socket.emit('joined-board', { ok: result.ok, visitors: userList, message: result.message});
            });
          } else if (result.ok === 1) {
            socket.emit('joined-board', result);
          }
        });
      });

      //  "disconnect" is emitted when the socket disconnected
      socket.on('disconnect', function () {
        socket.room.leaveAllRoom();

        // Mark socket is no longer used.
        socket = null;
      });

      // Initialization of backend services, which work upon socket.
      BoardMembership.init(socket);

      BoardMove.init(socket);

      require("./signals_registration");

    });

  };

}(exports));

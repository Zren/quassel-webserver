(function($) {
    $.QueryString = (function(a) {
        if (a == "") return {};
        var b = {};
        for (var i = 0; i < a.length; ++i)
        {
            var p=a[i].split('=');
            if (p.length != 2) continue;
            b[p[0]] = decodeURIComponent(p[1].replace(/\+/g, " "));
        }
        return b;
    })(window.location.search.substr(1).split('&'))
})(jQuery);

var networks = null
var socket = io(undefined, {
	timeout: 6000,
	reconnectionAttempts: 5
});
var NetworkCollection = require('network').NetworkCollection;
var Network = require('network').Network;
var IRCMessage = require('message').IRCMessage;
var IRCBufferCollection = require('buffer').IRCBufferCollection;
var IRCBuffer = require('buffer').IRCBuffer;
var IRCUser = require('user');
var HashMap = require('serialized-hashmap');
var Reviver = require('serializer').Reviver;
var reviver = new Reviver(NetworkCollection, Network, IRCBufferCollection, IRCBuffer, IRCUser, HashMap, IRCMessage);
var er = null;
var changesTimeout = [];
var loadingMoreBacklogs = [];

function connect(sock) {
	var host = $("#host").val();
	var port = $("#port").val();
	var user = $("#user").val();
	var password = $("#password").val();

	sock.emit('credentials', {
		server: host,
		port: port,
		user: user,
		password: password
	});
}

socket.on("connected", function() {
	console.log('CONNECTED');
	Views.connected();
});

er = new EventReceiver(socket, function(event) {
	socket.emit('register', event);
});

er.on('_error', function(next, e) {
	console.log('ERROR');
	console.log(e);
	switch (e.errno) {
	case 'ECONNREFUSED':
		Views.alert("Connection refused.");
		break;
	default:
		console.log('Unknown error.');
	}
	next();
});

er.on('loginfailed', function(next) {
	Views.alert("Invalid username or password.");
	next();
});

er.on('login', function(next) {
	console.log('Logged in');
	Views.showQuassel();
	next();
});

// Internal
er.on('_init', function(next, data) {
	console.log('_init');
	networks = data;
	reviver.reviveAll(networks);
	next();
});

// Internal
er.on('network._init', function(next, networkId, data) {
	console.log('network._init');
	reviver.reviveAll(data);
	networks.set(networkId, data);
	next();
}).after('_init');

er.on('network.init', function(next, networkId) {
	console.log('network.init');
	var network = networks.get(networkId);
	Views.addNetwork(network);
	next();
}).after('network._init');

er.on('network.addbuffer', function(next, networkId, bufferId) {
	console.log('addbuffer');
	var network = networks.get(networkId);
	var buffer = network.getBufferCollection().getBuffer(bufferId);
	reviver.afterReviving(buffer, function(obj) {
		if (obj.isStatusBuffer()) {
			Views.setStatusBuffer(network.networkName, obj);
		}
		else {
			Views.addBuffer(network.networkName, obj);
		}
		next();
	});
}).after('network.init');

er.on('change', function(next, networkId, change) {
	if (!jsonpatch.apply(networks.get(networkId), change)) {
		console.log('Patch failed!');
	}
	else {
		clearTimeout(changesTimeout[networkId]);
		changesTimeout[networkId] = setTimeout(function() {
			reviver.reviveAll(networks.get(networkId));
		}, 100);
	}
	next();
}).after('network.init');

er.on('buffer.backlog', function(next, bufferId, messageIds) {
	loadingMoreBacklogs[''+bufferId] = false;
	console.log('buffer.backlog : ' + bufferId);
	if (Views.isBufferShown(bufferId)) {
		var buffer = networks.findBuffer(bufferId), i = 0;
		for (; i<messageIds.length; i++) {
			var message = buffer.messages.get(messageIds[i]);
			Views.prependMessage(message);
		}
	}
	next();
}).after('network.addbuffer');

er.on('buffer.markerline', function(next, bufferId, messageId) {
	console.log('buffer.markerline : ' + bufferId + ", " + messageId);
	// TODO
	next();
}).after('network.addbuffer');

er.on('buffer.lastseen', function(next, bufferId, messageId) {
	console.log('buffer.lastseen : ' + bufferId + ", " + messageId);
	messageId = parseInt(messageId, 10);
	var buffer = networks.findBuffer(bufferId);
	if (buffer !== null && !buffer.isLast(messageId) && buffer.messages.has(messageId)) {
		Views.bufferHighlight(bufferId);
	}
	next();
}).after('network.addbuffer');

er.on('buffer.message', function(next, bufferId, messageId) {
	console.log('buffer.message : ' + bufferId + ", " + messageId);
	var buffer = networks.findBuffer(bufferId);
	var message = buffer.messages.get(parseInt(messageId, 10));
	if (Views.isBufferShown(bufferId)) {
		Views.addMessage(message, Views.scrollOnNewMessage);
		socket.emit('markBufferAsRead', bufferId, messageId);
	} else {
		Views.bufferHighlight(bufferId, message);
	}
	next();
}).after('network.addbuffer');

er.on('buffer.activate', function(next, bufferId) {
	Views.activateBuffer(bufferId);
	next();
}).after('network.addbuffer');

er.on('buffer.read', function(next, bufferId) {
	console.log('buffer.read : ' + bufferId);
	Views.bufferMarkAsRead(bufferId);
	next();
}).after('network.addbuffer');

er.on('buffer.unhide', function(next, bufferId, type) {
	Views.unhideBuffer(bufferId);
	next();
}).after('network.addbuffer');

er.on('buffer.hidden', function(next, bufferId, type) {
	Views.hideBuffer(bufferId);
	next();
}).after('network.addbuffer');

er.on('buffer.remove', function(next, bufferId) {
	Views.removeBuffer(bufferId);
	next();
}).after('network.addbuffer');

er.on('channel.join', function(next, bufferId, nick) {
	if (Views.isBufferShown(bufferId)) {
		var buffer = networks.findBuffer(bufferId);
		var user = networks.get(buffer.network).getUserByNick(nick);
		Views.addUser(buffer, user);
	}
	next();
});

er.on('user.part', function(next, networkId, nick, bufferName) {
	console.log(networkId, nick, bufferName);
	var network = networks.get(networkId);
	var buffer = network.getBuffer(bufferName);
	if (Views.isBufferShown(buffer.id)) {
		Views.removeUser(buffer, nick);
	}
	next();
});

//Socket.io events

socket.on('disconnect', function() {
	console.log('DISCONNECT');
	er.clearReceived();
	Views.disconnected();
});

socket.on('reconnect_attempt', function() {
	console.log('RECONNECTING');
	Views.connecting();
});

socket.on('reconnect_error', function() {
	console.log('RECONNECTING_ERROR');
	Views.disconnected();
});

socket.on('reconnect_failed', function() {
	console.log('RECONNECTING_FAILED');
	Views.disconnected();
});

socket.on('reconnect', function() {
	console.log('RECONNECT');
	er.redoCallbacks();
	Views.connected();
	Views.clear();
	connect(socket);
});

$(document).ready(function() {
	var fetchMoreBacklog = function() {
		var bufferId = parseInt($(".backlog").data('currentBufferId'), 10);
		if (typeof loadingMoreBacklogs[''+bufferId] === 'undefined' || loadingMoreBacklogs[''+bufferId] === false) {
			var buffer = networks.findBuffer(bufferId);
			var firstMessage = Math.min.apply(null, buffer.messages.keys());
			if ($(".backlog").scrollTop() === 0) {
				loadingMoreBacklogs[''+bufferId] = true;
				socket.emit('moreBacklogs', bufferId, firstMessage);
				updateLiveTimestamps();
			}
		}
	};

	var formatRelativeTimestamp = function(t1, t2) {
		var n = (t2-t1);
		var unit = 'ms';
		if (n >= 1000) { n = n / 1000; unit = 's';
			if (n >= 60) { n = n / 60; unit = 'm';
				if (n >= 60) { n = n / 60; unit = 'h';
					if (n >= 24) { n = n / 24; unit = 'd'; }
				}
			}
		}
		return Math.floor(n) + unit;
	};
	var updateLiveTimestamps = function() {
		if (window.liveTimestampsTimer) clearTimeout(window.liveTimestampsTimer);
		console.log('tick');
		var now = new Date();
		var mostRecent = 0;
		$('.live-timestamp').each(function(i, el) {
			var $el = $(el);
			var datetime = $el.attr('datetime');
			datetime = new Date(datetime);

			// Internal code for ticker
			if (mostRecent && datetime.getTime() > mostRecent) {
				datetime = datetime.getTime();
			}

			// Output
			$el.text(formatRelativeTimestamp(datetime, now));
		});
		var wait = now - mostRecent > 60 * 1000 ? 60 * 1000 : 1000;
		window.liveTimestampsTimer = setTimeout(updateLiveTimestamps, wait);
	};
	window.liveTimestampsTimer = setTimeout(updateLiveTimestamps, 1000);

	$(document).on("click", ".expanded", function() {
		var channel = $(this).data("target");
		$("#" + channel).css("max-height", "0");
		$(this).removeClass("expanded").addClass("collapsed");
	});

	$(document).on("click", ".collapsed", function() {
		var channel = $(this).data("target");
		$("#" + channel).css("max-height", "");
		$(this).removeClass("collapsed").addClass("expanded");
	});

	$(document).on("click", ".channel, .network .network-name", function() {
		var bufferId = parseInt($(this).data("bufferId"), 10);
		var buffer = networks.findBuffer(bufferId);
		var lastMessageId = Views.showBuffer(buffer);
		socket.emit('markBufferAsRead', buffer.id, lastMessageId);
		if ($('.backlog').scrollTop() === 0) {
			fetchMoreBacklog();
		}
		updateLiveTimestamps();
	});

	$(document).on("click", ".add-channel", function() {
		var NetworkId = $(this).data('network');
		$("#join-network-name").html(NetworkId);
	});

	$(".logout, .reconnect").on("click", function() {
		Views.showLoginPage();
	});

	$('#modal-join-channel').on('hidden.bs.modal', function() {
		$('#modal-join-channel-name').val("");
	});

	var sendMessage = function() {
		if (socket !== null) {
			var bufferId = parseInt($(".backlog").data('currentBufferId'), 10);
			var message = $("#messagebox").val();
			$("#messagebox").val("");
			socket.emit('sendMessage', bufferId, message);
		}
	};

	$("form#messageform").on("submit", function(evt) {
		evt.preventDefault();
		sendMessage();
	});

	$("#messagebox").on("keydown", function(evt) {
		if (evt.which == 13) { // Enter
			evt.preventDefault();
			sendMessage();
		} else if (evt.which == 9) { // Tab
			console.log('tab');
			evt.preventDefault();
			var tokenEnd = this.selectionEnd;
				
			var message = $(this).val();
			var messageLeft = message.substr(0, tokenEnd);
			var tokenStart = messageLeft.lastIndexOf(' ');
			tokenStart += 1; // -1 (not found) => 0 (start)
			var token = messageLeft.substr(tokenStart);

			// Find the most recent nick who has talked.
			var getMostRecentNick = function(token) {
				var bufferId = $(".backlog").data('currentBufferId');
				if (!bufferId) return;
				bufferId = parseInt(bufferId, 10);
				var buffer = networks.findBuffer(bufferId);
				if (!buffer) return;

				var keys = buffer.messages.keys();
				keys.sort();
				keys.reverse();

				for (var i = 0; i < keys.length; i++) {
					var messageId = keys[i];
					var message = buffer.messages.get(messageId);

					// Only check Plain and Action messages for nicks.
					if (!(message.type == MT.Plain || message.type == MT.Action))
						continue;

					var nick = message.getNick();
					if (nick.length <= token.length)
						continue;

					if (token.toLowerCase() == nick.toLowerCase().substr(0, token.length))
						return nick;
				}
			};

			// Find the closet nick alphabetically from the current buffer's nick list.
      var getNickAlphabetically = function(token) {
        var bufferId = $(".backlog").data('currentBufferId');
        if (!bufferId) return;
        bufferId = parseInt(bufferId, 10);
        var buffer = networks.findBuffer(bufferId);
        if (!buffer) return;

        var nicks = Object.keys(buffer.nickUserMap);
        nicks.sort(function(a, b) {
          return a.toLowerCase().localeCompare(b.toLowerCase());
        });

        for (var i = 0; i < nicks.length; i++) {
          var nick = nicks[i];
          if (nick.length <= token.length)
            continue;

          if (token.toLowerCase() == nick.toLowerCase().substr(0, token.length))
            return nick;
        }
      };
      

			var getTokenCompletion = function(token) {
				var nick = getMostRecentNick(token);
				if (!nick)
					nick = getNickAlphabetically(token);

				if (nick) {
					if (tokenStart == 0) {
						return nick + ': ';
					} else {
						return nick;
					}
				}
			};

			var newToken = getTokenCompletion(token);

			if (newToken) {
				var newMessage = message.substr(0, tokenStart) + newToken + message.substr(tokenEnd);
				$(this).val(newMessage);
				var newTokenEnd = tokenEnd + newToken.length - token.length;
				this.setSelectionRange(newTokenEnd, newTokenEnd);
			}
		}
	});

	$("#hide-buffers").click(Views.hideBuffers);
	$("#show-buffers").click(Views.showBuffers);

	$("#hide-nicks").click(Views.hideNicks);
	$("#show-nicks").click(Views.showNicks);

	$(".backlog").on('mousewheel', function(event) {
		if (event.deltaY > 0) { // up
			fetchMoreBacklog();
		}
	});

	$("#logonform").on("submit", function(evt) {
		console.log('SENDING CREDENTIALS');
		evt.preventDefault();
		connect(socket);
	});

	$(".logout").on("click", function(evt) {
		socket.emit('logout');
		window.location.reload();
	});

	$(".topic li").on("click", function(evt) {
		evt.stopPropagation();
	});

	$(".topic li a").on("click", function(evt) {
		if (!$(evt.target).is("input")) {
			var checked = $(this).children("input").is(':checked');
			$(this).children("input").prop('checked', !checked).trigger("change");
		}
	});

	$(".topic li input[data-message-type]").on("change", function(evt) {
		var type = $(this).data("messageType");
		if (!$(this).is(':checked')) {
			Views.showMessageTypes(type);
		} else {
			Views.hideMessageTypes(type);
		}
	});

	$(".topic li input[data-default-filter]").on("change", function(evt) {
		if ($(this).is(':checked')) {
			Views.useDefaultFilter();
		} else {
			Views.doNotUseDefaultFilter();
		}
	});

	function setQueryParamOrFocus(queryParamKey, selector) {
		if ($.QueryString[queryParamKey]) {
			$(selector).val($.QueryString[queryParamKey]);
		} else if (!$(selector).val()) {
			$(selector).focus();
		}
	}
	setQueryParamOrFocus('password', '#password');
	setQueryParamOrFocus('host', '#host');
	setQueryParamOrFocus('port', '#port');
	setQueryParamOrFocus('user', '#user');

	if ($("#host").val() && $("#port").val() && $("#user").val() && $("#password").val()) {
		$('#logonform').submit();
	}

	er.on('buffer.backlog', function(next, bufferId, messageIds) {
		var currentBufferId = parseInt($(".backlog").data('currentBufferId'), 10);
		if (currentBufferId === bufferId) {
			if (messageIds.length > 0 && $(".backlog").scrollTop() === 0) {
				fetchMoreBacklog();
			}
		}
		next();
	});
});

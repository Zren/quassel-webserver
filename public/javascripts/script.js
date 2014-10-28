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
	Views.addNetwork(network.networkName);
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

	$("form#messageform").on("submit", function(evt) {
		evt.preventDefault();
		if (socket !== null) {
			var bufferId = parseInt($(".backlog").data('currentBufferId'), 10);
			var message = $("#messagebox").val();
			$("#messagebox").val("");
			socket.emit('sendMessage', bufferId, message);
		}
	});

	$("#hide-buffers").click(Views.hideBuffers);
	$("#show-buffers").click(Views.showBuffers);

	$("#hide-nicks").click(Views.hideNicks);
	$("#show-nicks").click(Views.showNicks);

	$(".backlog").on('mousewheel', function(event) {
		if (event.deltaY > 0) { // up
			var bufferId = parseInt($(".backlog").data('currentBufferId'), 10);
			if (typeof loadingMoreBacklogs[''+bufferId] === 'undefined' || loadingMoreBacklogs[''+bufferId] === false) {
				var buffer = networks.findBuffer(bufferId);
				var firstMessage = Math.min.apply(null, buffer.messages.keys());
				if ($(".backlog").scrollTop() === 0) {
					loadingMoreBacklogs[''+bufferId] = true;
					socket.emit('moreBacklogs', bufferId, firstMessage);
				}
			}
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

	$(".topic li input").on("change", function(evt) {
		var type = $(this).data("messageType");
		if (!$(this).is(':checked')) {
			Views.showMessageTypes(type);
		} else {
			Views.hideMessageTypes(type);
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

	er.on('buffer.order', function(next, bufferId, messageIds) {
		// Auto select buffer
		// Show buffer if it is set, and we do not yet have a currentBufferId.
		var queryBufferId = $.QueryString['bufferId'];
		var currentBufferId = $(".backlog").data('currentBufferId');
		if (!currentBufferId && queryBufferId) {
			queryBufferId = parseInt(queryBufferId, 10);
			if (bufferId == queryBufferId) {
				console.log('queryBufferId', queryBufferId);
				var buffer = networks.findBuffer(bufferId);
				var lastMessageId = Views.showBuffer(buffer);
				socket.emit('markBufferAsRead', buffer.id, lastMessageId);
			}
		}
		next();
	});
	
});

var nano = require('nanomsg'),
	cbor = require('cbor'),
	crypto = require('crypto'),
	async = require('asyncawait/async'),
	await = require('asyncawait/await');
	
	

// Define the port number to use
var REPLY_URL = 'tcp://*:5555',
	PUBLISH_DEVS_URL = 'tcp://*:6666',
	PUBLISH_CLDS_URL = 'tcp://*:6677';


//==========================================================
// GLOBAL DATA STRUCTURES
// Shhh..! I am using global variables! Need to figure an
// elegant alternative. We will get through this prototype
// with this ugliness!
//==========================================================

var devTable = {},
	funcRegistry = {},
	activityTable = {},
	runTable = {},
	portsArray = [],
	surveyPorts = [],
	publishBuffer = [];
	
var readyPolicy = "Majority",
	policyValue = 1.0,
	surveyThreshold = 0.5;


// Some global values that needs adjustment.
var syncTimeout = 500;


exports.JServer = new function () {
	
	this.registerCallback = function(fk, mask) {
		if (fk.name === "") {
			console.log("Anonymous functions cannot be callbacks... request ignored");
			return;
		}

		if (funcRegistry[fk.name] !== undefined) {
			console.log("Duplicate registration: " + fk.name + ".. overwritten.");
		}

		funcRegistry[fk.name] = {func: fk, mask:mask};	
	}
	
	this.remoteSyncExec = async (function (name, params, expr) {
		
		var tmsg = {"cmd": "REXEC-CALL", "opt": "SYN", "actname": name, "actid": "__", "actarg": expr, "args": params};
		var runid = crypto.createHash('md5').update(JSON.stringify(tmsg)).digest('hex');
		tmsg["actid"] = runid;
		
		try {
			await(getSyncCallPublished(tmsg, runid, PUBLISH_RETRIES, syncTimeout));
			return await(getSurveyResults(runid));
		}
		catch (e) {
			cancelSurvey(runid);
			cancelAllJobs(runid);
			throw(e);
		}
	});
	
	this.remoteAsyncExec = function(name, params, expr) {
		
		var tmsg = {"cmd": "REXEC-CALL", "opt": "ASY", "actname": name, "actid": "__", "actarg": expr, "args": params};
		var runid = crypto.createHash('md5').update(JSON.stringify(tmsg)).digest('hex');
		
		tmsg["actid"] = runid;
		
		// publish the message..
		publishMsg(tmsg, runid, PUBLISH_RETRIES);
		
		// insert callback processing into the RequestSock processor
		createRunId(runid);
	}
	
	this.cancelExecTask = function(name, params) {
		
		// This is just unpublishing from the local publish buffer
		// We are not sending any cancellation messages. 
		// IMPORTANT: No remote messages are sent for cancellation ...
		//
		var tmsg = {"cmd": "REXEC-CALL", "opt": "ASY", "actname": name, "actid": "__", "actarg": "__", "args": params};
		var runid = crypto.createHash('md5').update(JSON.stringify(tmsg)).digest('hex');
		
		unpublishMsg(runid);
		removeRunId(runid);	
	}

	this.setReadyPolicy = function (policy, value) {
		readyPolicy = policy;
		policyValue = value;
	}
	
	this.setSurveyThreshold = function(value) {
		surveyThreshold = value;
	}

}


//==========================================================
// SYNCHRONOUS CALL PROCESSING SECTION
// Routines for synchronous call processing.
//==========================================================


// Returns a promise... note that the await() is going to
// hang until resolve() or reject() is called.
//
function getSyncCallPublished(tmsg, runid, PUBLISH_RETRIES, timeout) {
	
	return new Promise(function(resolve, reject) {
		
		// Create the runTable 
		var ren = createRunId(runid);
		 
		// Start the surveyor
		startTheSurveyor(ren);
		
		// Put the tmsg into the publish buffer.. that should be sufficient
		publishMsg(tmsg, runid, PUBLISH_RETRIES);
		
		// Set timeout to cleanup with the rejection..
		var timeid = setTimeout(function () {
			ren.reject(runid);
		}, timeout);
		
		// Insert the resolve and reject handlers into runTable..
		ren.resolve = resolve;
		ren.reject = reject;
		ren.timer = timeid;
	});
	// Resolve or Reject handlers are activated by the event loop.
	// So we are going to end up waiting until something happens there or the
	// timeout fires.
}


// Again return a promise.
// 	
function getSurveyResults(runid) {
	var ren;

	return new Promise(function(resolve, reject) {
		if ((ren = runTable[runid]) === undefined)
			throw('Undefined RunTable Entry');
			
		injectSurvey(ren);
		
		// Insert the resolve and reject handlers into runTable..
		ren.survey_resolve = resolve;
		ren.survey_reject = reject;		
	});
}


// Inject the survey... 
// 
//
function injectSurvey(ren) {
	
	// create the survey message...
	var nmsg = {"cmd": "REPORT-REQ", "opt": "SYN", "actname": "EVENTLOOP", "actid": "__", "actarg": runid, "args": []};
	
	var encodemsg = cbor.encode(nmsg);
	ren.socket.send(encodemsg);

}


// Cancel the survey; Close the survey socket.
// Return the survey port to unused port so that another survey
// instance can reuse it..
//
function cancelSurvey(runid) {
	
	var ren = runTable[runid];
	if (ren === undefined)
		return;
	if (ren.socket !== undefined)
		ren.socket.close();
	surveyPorts.push(ren.sport);
	
}

// Send a cancellation message to the C-cores so that they can 
// stop working on the runid tasks..
//
function cancelAllJobs(runid) {
	
	var ren = runTable[runid];
	if (ren === undefined)
		return;

	// Create the cancellation message..
	var cmsg = createRexecKillMsg(runid);
	
	// Push it into the publish queue... no need to wait for the message to disseminate
	publishMsg(cmsg, runid, PUBLISH_RETRIES);	
}


function createRexecKillMsg(runid) {
	
	var nmsg = {"cmd": "REXEC-KILL", "opt": "SYN", "actname": "ACTIVITY", "actid": "__", "actarg": runid, "args": []};
	return nmsg;	
}


//==========================================================
// INITIALIZATION SECTION
// Initialize some of the global structures here.
//==========================================================


// TODO: Check whether a service is already using a port 
// If not, return false.. otherwise return true 
//
function portAlreadyUsed(port) {
	
	// TODO: Fixme..
	return false;
}



function setupSystem() {
	// Check whether master ports are working..
	//
	if (portAlreadyUsed(5555))
		throw("Port 5555 is already taken");
	if (portAlreadyUsed(6666))
		throw("Port 6666 is already taken");
	if (portAlreadyUsed(6677))
		throw("Port 6677 is already taken");
	if (portAlreadyUsed(7777))
		throw("Port 7777 is already taken");
	if (portAlreadyUsed(7788))
		throw("Port 7788 is already taken");	
	
	// Initialize ports for Request-Reply purposes
	// This is used by the services..
	//
	for (i = 25000; i < 35000; i++) {
		if (portAlreadyUsed(i)) continue;
		portsArray.push(i);
	}
	
	// Initialize ports for Survey purposes
	//
	for (i = 40000; i < 50000; i++) {
		if (portAlreadyUsed(i)) continue;
		surveyPorts.push(i);
	}
}


function getResults(sock, cmsg) {
	
	var nmsg,
		res = activityTable[cmsg["actid"]];
	if (res === undefined) {
		nmsg = {"cmd": "REXEC-RES", "opt": "PUT", "actname": "ACTIVITY", "actid": cmsg["actid"], "actarg": "NOT-FOUND", "args": []};
	}
	else
		nmsg = {"cmd": "REXEC-RES", "opt": "PUT", "actname": "ACTIVITY", "actid": cmsg["actid"], "actarg": "RESULTS", "args": [res]};
	
	var encodemsg = cbor.encode(nmsg);
	sock.send(encodemsg);
}


function replyExecReady(sock, cmsg, ren) {
	
	var nmsg;
	
	if (ren === undefined) {
		nmsg = {"cmd": "REXEC-QUI", "opt": "ASY", "actname": "EVENTLOOP", "actid": cmsg["actid"], "actarg": cmsg["actarg"], "args": []};
	}
	else
	{
		if (checkReadyPolicy(ren))
			nmsg = {"cmd": "REXEC-STA", "opt": "ASY", "actname": "EVENTLOOP", "actid": cmsg["actid"], "actarg": cmsg["actarg"], "args": []};
		else
			nmsg = {"cmd": "REXEC-QUI", "opt": "ASY", "actname": "EVENTLOOP", "actid": cmsg["actid"], "actarg": cmsg["actarg"], "args": []};
	}			
	
	var encodemsg = cbor.encode(nmsg);
	sock.send(encodemsg);
}


function replySyncExecReady(sock, cmsg, ren) {
	
	var nmsg;
	
	if (ren === undefined) {
		nmsg = {"cmd": "REXEC-QUI", "opt": "SYN", "actname": "EVENTLOOP", "actid": cmsg["actid"], "actarg": cmsg["actarg"], "args": []};
	}
	else
	{
		if (checkReadyPolicy(ren))
			nmsg = {"cmd": "REXEC-STA", "opt": "SYN", "actname": "EVENTLOOP", "actid": cmsg["actid"], "actarg": cmsg["actarg"], "args": [ren.sport]};
		else
			nmsg = {"cmd": "REXEC-QUI", "opt": "SYN", "actname": "EVENTLOOP", "actid": cmsg["actid"], "actarg": cmsg["actarg"], "args": []};
	}			
	
	var encodemsg = cbor.encode(nmsg);
	sock.send(encodemsg);
}	


function checkResolveCond(ren) {

	if ((readyPolicy === "Majority") && 
		(ren.replied/ren.needed > policyValue)) {
		clearTimeout(ren.timer);
		ren.resolve();
	}
	else
	if ((readyPolicy === "First") && 
		(ren.replied === 1)) {
		clearTimeout(ren.timer);			
		ren.resolve();
	}
}


function checkReadyPolicy(ren) {
	
	// False conditions are caught by the last return..
	// No need to handle them in the intermediate if statements..
	if (readyPolicy === "Majority") {
		if (policyValue >= 1.0)
			return true;
		
		if (ren.replied/ren.needed < policyValue)
			return true;
	} else
	if (readyPolicy === "First") {
		if (ren.replied == 1)
			return true;
	}

	return false;	
}

function checkArgsType(args, tmask) {
	
	if (args.length !== tmask.length) 
		return false;
	
	for (i = 0; i < args.length; i++) {
		if ((typeof(args[i]) === 'string') && (tmask[i] !== 's')) {
			return false;			
		}
		else
		if ((typeof(args[i]) === 'number') && (tmask[i] !== 'n')) {
			return false;
		}
	}
	return true;
}


//==========================================================
// REPLY PROCESSING SECTION
// This is meant to process the request-reply messages
//==========================================================

var rep = nano.socket('rep');
rep.bind(REPLY_URL);

setupSystem();


rep.on('data', function(buf) {
	console.log("Buffer size " + Buffer.byteLength(buf));
	cbor.decodeFirst(buf, function(error, msg) {
		// if error != null .. it seems nanomsg is
		// receiving more bytes than what the C sent..
		// TODO: investigate this pr

		try {
			adminProcessor(rep, msg, function(obj) {
				var encode = cbor.encode(obj);
				rep.send(encode);
				console.log(obj);
			});
		} catch(err) {
			console.log("errror..", err);
		}
	});
});


function adminProcessor(sock, msg, callback) {

	switch (msg["cmd"]) {
		case "REGISTER":
			if (msg["opt"] === "DEVICE") {
				var devidrcd = msg["actid"];
				if (devidrcd !== undefined && devTable[devidrcd] !== undefined) {
				 	var devid = getAlternateID(msg, devidrcd);
				 	var opt = "ALT";
				} else {
				 	var opt = "ORI"
					devid = devidrcd;
				}
				var port = portsArray.shift();
				startReqService(port, function() {
					insertDevTableEntry(msg, devid, port);

					msg = reviseMsgStruct(msg, "REGISTER-ACK", opt, devid, port);
				 	callback(msg);
				});
			}
		break;
		default:
			console.log(msg["cmd"] + "received...");
			throw("Unknown command");
	}

}


function startReqService(port, callback) {

	var sock = nano.socket('rep');
	var url = "tcp://*:" + port;
	sock.bind(url);

	sock.on('data', function(buf) {
		cbor.decodeFirst(buf, function(error, msg) {
			if ((msg["cmd"] === "REXEC") &&
				(msg["opt"] === "SYN")) {
				runSyncCallback(sock, msg);
			}
			else
			if ((msg["cmd"] === "REXEC") &&
				(msg["opt"] === "ASY")) {
				runAsyncCallback(sock, msg);	
			}
			else
			if ((msg["cmd"] === "REXEC-RES") &&
				(msg["opt"] === "GET")) {
				getResults(sock, msg);
			}
			else
			if ((msg["cmd"] === "REXEC-RDY") && 
				(msg["opt"] === "ASY")) { 
				var ren = checkRunId(msg["actarg"]);
				replyExecReady(sock, msg, ren);
			}
			else
			if ((msg["cmd"] === "REXEC-RDY") &&
				(msg["opt"] === "SYN")) {
				var ren = checkRunId(msg["actarg"]);
				replySyncExecReady(sock, msg, ren);				
				if (ren !== undefined) {
					checkResolveCond(ren);
				}
			}
			else
			if (msg["cmd"] === "PING") {
				msg["cmd"] = "PONG";
				updateHeartBeat(msg["actid"]);
				var encode = cbor.encode(msg);
				sock.send(encode);
			}
		});
	});

	console.log("Started the service...at:" + url);
	callback();
}


function runAsyncCallback(sock, cmsg) {

	var fentry = funcRegistry[cmsg["actname"]];
	console.log("Looking for.. [" + fentry + "].... " + cmsg["actname"]);
	if (fentry === undefined) {
		// send an REXEC-NAK message: {REXEC-NAK, ASY, ACTIVITY, actid, device_id, error_code}
		var nmsg = {"cmd": "REXEC-NAK", "opt": "ASY", "actname": "ACTIVITY", "actid": cmsg["actid"], "actarg": cmsg["actarg"], "args": ["NOT-FOUND"]};		
		var encodemsg = cbor.encode(nmsg);
		sock.send(encodemsg);
		console.log("Sent the message..NOT-FOUND");
	}
	else
	{
		// create actid, select lease-value, put entry in the activity table
		// send [REXEC-ACK ASY ACTIVITY actid device_id lease-value (arg0) ]
		activityTable[cmsg["actid"]] = undefined;
		
		var nmsg = {"cmd": "REXEC-ACK", "opt": "ASY", "actname": "ACTIVITY", "actid": cmsg["actid"], "actarg": cmsg["actarg"], "args": []};		
		var encodemsg = cbor.encode(nmsg);
		sock.send(encodemsg);
		
		// Run function
		var res = fentry.func.apply(this, cmsg["args"]);
		activityTable[cmsg["actid"]] = res;
		console.log("Execution complete.. results stored...");		
	}	
}


function runSyncCallback(sock, cmsg) {

	var fentry = funcRegistry[cmsg["actname"]];
	console.log("Looking for.. [" + fentry + "].... " + cmsg["actname"]);
	if (fentry === undefined) {
		// send an REXEC-NAK message: {REXEC-NAK, SYN, ACTIVITY, actid, device_id, error_code}
		var nmsg = {"cmd": "REXEC-NAK", "opt": "SYN", "actname": "ACTIVITY", "actid": cmsg["actid"], "actarg": cmsg["actarg"], "args": ["NOT-FOUND"]};		
		var encodemsg = cbor.encode(nmsg);
		sock.send(encodemsg);
		console.log("Sent the message..NOT-FOUND");
	}
	else
	if (checkArgsType(cmsg["args"], fentry.mask) !== true) {
		// send an REXEC-NAK message: {REXEC-NAK, SYN, ACTIVITY, actid, device_id, error_code}
		var nmsg = {"cmd": "REXEC-NAK", "opt": "SYN", "actname": "ACTIVITY", "actid": cmsg["actid"], "actarg": cmsg["actarg"], "args": ["ILLEGAL-PARAMS"]};		
		var encodemsg = cbor.encode(nmsg);
		sock.send(encodemsg);
		console.log("Sent the message..ILLEGAL-PARAMS");
	} 
	else
	{
		// create actid, select lease-value, put entry in the activity table
		// send [REXEC-ACK SYN ACTIVITY actid device_id lease-value (arg0) ]
		activityTable[cmsg["actid"]] = undefined;
		
		var nmsg = {"cmd": "REXEC-ACK", "opt": "SYN", "actname": "ACTIVITY", "actid": cmsg["actid"], "actarg": cmsg["actarg"], "args": []};		
		var encodemsg = cbor.encode(nmsg);
		sock.send(encodemsg);
		
		// Run function
		var res = fentry.func.apply(this, cmsg["args"]);
		activityTable[cmsg["actid"]] = res;

		console.log("Execution complete.. results stored...");		
	}	
}

	
function getAlternateID(msg, devid)
{
	var aname = msg["actname"],
		dname = msg["actarg"];

	var indx = 1;

	do {
		var tempid = aname + "|" + dname +"(" +  indx + ")";
		indx++;
	} while (devTable[tempid] !== undefined);

	return tempid;
}

function insertDevTableEntry(msg, devid, port) {

	var entry = {"app_name": msg["actname"], "device_name": msg["actid"], "port": port, "ping_time": (new Date()).getTime()};
	devTable[devid] = entry;
}


function getActiveDevCount() {
	var count = 0;
	
	for (var devid in devTable) {
		var den = devTable[devid];
		if (((new Date()).getTime() - den["ping_time"]) < 50000)
			count++
	}
	
	return count;
}

function updateHeartBeat(devid) {
	var den = devTable[devid];
	den["ping_time"] = (new Date()).getTime();
}


function reviseMsgStruct(msg, cmd, opt, devid, port) {
	msg["cmd"] = cmd;
	msg["opt"] = opt;
	msg["args"] = [ port, devid];

	return msg;
}



//==========================================================
// PUBLISH PROCESSING SECTION
// Setup the Publish processing section
//==========================================================

var pub = nano.socket('pub');
pub.bind(PUBLISH_DEVS_URL);

function publishMsg(msg, tag, retries) {		
	publishBuffer.push({"msg": msg, "tag": tag, "retries": retries});
}


function unpublishMsg(tag) {
	
	for (i = 0; i < publishBuffer.length; i++) {
		var elem = publishBuffer.shift();
		if (elem !== undefined && elem.tag !== tag)
			publishBuffer.push();
	}
}

setInterval(function() {
	
	for (i = 0; i < publishBuffer.length; i++) {
		var elem = publishBuffer.shift();
		if (elem !== undefined) {
			if (elem.retries-- > 0) {
				var bmsg = cbor.encode(elem.msg);
				pub.send(bmsg);
				publishBuffer.push(elem);				
			}
		}
	}
}, 2000);


//==========================================================
// EXECUTION PROCESSING SECTION
// Process different type of protocol portions
//==========================================================

var PUBLISH_RETRIES = 5;


function checkRunId(runid) {
	
	var ren = runTable[runid];
	if (ren !== undefined) {
		ren["replied"]++;
		
		if (ren["replied"] >= ren["needed"]) 
			unpublishMsg(runid);
	}
	
	return ren;
}


function createRunId(runid) {
	
	runTable[runid] = {"replied": 0, "needed": 0,
					   "resolve": undefined, "reject": undefined,
					   "sport": 0, "socket": undefined, "timer": undefined,
					   "survey_resolve": undefined, "survey_reject": undefined, "survey_timer": undefined,
					   "results": [], "collected": false};
	
	return runTable[runid];
}


function removeRunId(runid) {
	if (runTable[runid] !== undefined)
		delete(runTable[runid]);
}


//==========================================================
// SURVEY PROCESSING SECTION
// Setup the Survey processing section
//==========================================================



function startTheSurveyor(ren, timeout) {
	
	var sur = nano.socket('surveyor');
	
	var sport = surveyPorts.shift();
	if (sport === undefined)
		throw("Cannot get a free survey port");
		
	sur.bind("tcp://*:" + sport);

	ren.socket = sur;
	ren.sport = sport;
	
	// Set timeout to cleanup with the rejection..
	var stimeid = setTimeout(function () {
		ren.survey_reject(undefined);
	}, timeout);
	
	ren.survey_timer = stimeid;
	
	// This event driven loop processes the resolve..
	// that triggers the survey results creation..
	//
	sur.on('data', function(buf) {
		cbor.decodeFirst(buf, function(error, msg) {
			runid = msg["actarg"];
			value = msg["args"][0];
			if (value !== undefined) {
				var rentry = runTable[runid];
				if (rentry !== undefined) {
					rentry.results.push(value);
					if (rentry.results.length/rentry.needed > surveyThreshold) {
						clearTimeout(rentry.survey_timer);
						rentry.resolve(rentry.results);
					}
				}
			} 
		});
	});	
}
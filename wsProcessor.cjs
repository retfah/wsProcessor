


/**
 * How WebSockets and TCP work; especially how connection errors are detected
 * TCP: 
 * - opens a connection between client and server, which in the case of ws is kept open. 
 * - Starting up the connection is acknowledged (Syn, Syn/Ack, Ack), as well as every piece of data sent through the tcp connection. 
 * - TCP does not necessarily have heartbeat signal to realize when the connection has failed. In contrast: it might try for hours to connect to a unreachable server or resend some data without raising an error to the calling application. 
 * - Heartbeats basically exist in the form of TCP-keep-alive packages, which can help to notify routers between both ends to keep the connection open. (Note that this might be e.g. important for NAT-Routers.) In an experimental investigation with wireshark the same browser/OS combination on two different computers once "never" (>several minutes) sent keep-alive packages, while the other sent one every 45s. !!! Additionally, I don't know whether a connection error would be raised on keep-alive-ack-failure or not!!! So we cannot rely on tcp-things to detect a connection error. If e.g. a netweork cable was removed on one side, this computer might raise on error, since removing the cable is electrically realized. (Exemplary investigation: the browser does not realize it or at least does not change the ready-state of the ws-connection.) The other end of the connection woudl not realize it (=> the connection is then called half-open). 
 * - The only way, how a failed tcp-connection can be detected if by some sort of heartbeats/keep-alive packages and timeouts. See e.g. https://www.codeproject.com/Articles/37490/Detection-of-Half-Open-Dropped-TCP-IP-Socket-Conne
 * 
 * WebSocket: 
 * - RFC 6455: https://tools.ietf.org/html/rfc6455
 * - WsApi (in browsers): https://html.spec.whatwg.org/multipage/web-sockets.html
 * - Connection is established through an "Upgrade" from a regular http connection, which is tcp as well. The underlying tcp connection will then be kept open. 
 * - WS knows 4 states (in WsApi in browsers called readyState, number in parantheses: CONNECTING (0), OPEN (1), CLOSING (2); CLOSED (3). It is connecting dureing the handshakes at the beginning and then open. As soon as one client wants to close the connection, the status on the client is closing, until the closing ack arrives at the client again, when the status changes to closed. 
 * - WS defines special ping and pong frames, meant to check the connection state. An incoming ping frame MUST be answered with pong. In the WsApi used in browsers, it is unfortunately not possible yet (2021-03) to send pings or raise an event on incoming pings. Therefore, the ping/pong must be implemented in wsProcessor!
 * - Unfortunately, ws does not raise an error if sending a request fails (or at least it is not documented). Probably because it would first retry sending for some undocumented time.
 * - Experiment: removing the ethernet cable does not change the state of the connection (still OPEN...). It took roughly 18 seconds after "sending" (trying to) a message over the dead connection until the onerror/onclose event (one of those events; actually I dont know when onerror is raised) was raised. This shows again, that some kind of heartbeam must be implemented in wsProcessor.
 * - Experiment: shutting down or killing the server (on Windows) is NOT equivalent to a detached cable! It seems that the sockets handling is done by the OS and killing the server means that the reserved port gets free and the socket related to it are closed with a final RST/ACK (i.e. not a normal closing, but a least a message is sent). This leads to a termination of the connection on the client, which is not the same as if the cable was detached, where no closingEvent would be raised. 
 * 
 * wsProcessor: 
 * - This class is basically a wrapper around a ws-connection, implementing heartbeats (ping/pong) on application level and providing its own syn/ack for requests and notes. 
 * - Acknowledged notes/requests raise events on failure, after a certain timeout. (Successfull events raise success-events on success.)
 * - Implementation of ping/pong: 
 *   - 1. assume a basic round trip time, e.g. rtt=1s
 *   - 2. send a ping every max(2s, 10*rtt) and wait max(10s, 50*rtt) for responses. If no response is received within this duration, the connection is deemed failed and thus explicitly closed. 
 *   - always monitor the rtt; e.g. recalculate it as the mean over the last n pings. (I suggest to use n=2 only, to react fastly if the connection gets slower/congested or the server has a high workload.) 
 * - Implementation of notes: 
 *   - one side sends a note; if an ack is requested, the other side immediately answers with an ack (I mean an ack in wsProcessor, not an ack on tcp level).
 *   - possible outcomes from the point of view of the sender if he requested an ack (cbAck status code):
 *     - success (0): ack arrives
 *     - fail 1 (1): before timeout, the connection is deemed broken
 *     - fail 2 (2): ack does not arrive on time (timeout reached)
 *   - possible outcomes from the point of view of the receiver:
 *     - not implemented: ack cannot be sent, if in the extremely rare case that the connection closes between receiving the note and sending the ack
 * 
 *  - (harmonized) implementation of requests
 *    - one side sends out a request, the other side responds; the requesting party my ask for an acknowledgement, which is sent by the responding partly immediately upon arrival of the request and results in the execution of the status callback. This is helpful espacially if the processing on the server will take longer, increasing the risk of connection loss inbetween; then the client knows at least that the processing has started; if the response does not arrive within a certain period of time (default=10s) or if the connection is lost before, the failure callback will be executed with the respective error code and message. 
 *    - possible outcomes on requesting party (callback and code):
 *      (3 cases need to be considered: (1) no ack, (2) ack without ackTimeout, (3) ack with ackTimeout)
 *      - success: response arrives, if requested, response-ack is sent
 *      - fail 1: (1) connection closed before requestTimeout 
 *        - fail 1.1: (2+3) ... after ack arrived
 *        - fail 1.2: (2) ... before ack arrived
 *                    (3) ... before ack arrived and before ack timed out 
 *        - fail 1.3: (3) ... after ack timed out
 *      - fail 2: (1) request timed out
 *        - fail 2.1: (2+3) ... after ack arrived
 *        - fail 2.2: (2) ... before ack arrived
 *                    (3) ... before ack arrived and before ack timed out; this should not exist, since the ackTimeout should be smaller than the requestTimeout; thus, if the request times out, the ack already has timed out.
 *        - fail 2.3: (3) ... after ack timed out
 *      - ackStatus 0: (2+3) ack arrived
 *      - ackStatus 1: (3) ack timed out; IMPORTANT: this does NOT delete the request from the stack; i.e. the response might still arrive later! (Only the requestTimeout deletes the request from the stack.) 
 *      - Note: the cbAck will not be called with an error if the connection is lost. Only failure will be called then.
 * 
 *    - possible outcomes on the responding party (cbAck):
 *      - ackCode = 0/success: when the requestAck arrives within the timeout
 *      - ackCode = 1*: the connection is lost before the ack arrived (important: see note below)
 *      - ackCode = 2: no ack arrived within the timeout (if set)
 *      - ackCode = 3*: response cannot be sent since the connection is already closed (important: see note below)
 *      - NOTE: There can be cases where ackCode 1 is returned, despite the fact the response never arrived on the client (actual ackCode 3). This happens when the connection is actually already in closing/closed state, but this information did not yet arrive in the wsProcessor. This is due to synchronous handling on the server. Only if the request is processed async, there is the chance that the closing state gets processed before the response shall be sent. Event then, it significantly depends on how the async parts are defined!  

 */

// Why this is needed: 
// - Websockets run on TCP, which basically would guarantee that messages arrive thank to the acknowledgements. But since the information about whether a message was successfully is not given to the webSocket class, we still need to create out own syn/ack on the websocket level. 






/**
 * INFORMATION ABOUT THE CALLBACKS:
 * eventuelly to write again a little more easy to understand than above
 * /


/** log levels
 * default winston log levels (from here: https://sematext.com/blog/node-js-logging/): 
 * 0: error		errors that cannot be handled by the calling functions, e.g. errors about packages that cannot be processed. (They are not fatal in a way that it crashed. )
 * 1: warn		errors that are anyway reported to the calling functions (e.g. by calling cbFailure)
 * 2: info		not used
 * 3: verbose	e.g. all incoming messages
 * 4: debug		ping/pong messages
 * 5: silly		not used
 */

/**
 * The class extending the basic ws connection with two different types of data trasfer: notes and requests; both with and without acknowledgement of the messages.
 */
	module.exports  = class wsProcessor{

		/**
		 * wsProcessor constructor: 
		 * @param {function} sendingFunc The function to be called for sending a message with the only parameter beeing the message.
		 * @param {function} closingFunction A function to be called to close the websocket connection. Used when the heartbeats are not successful anymore.
		 * @param {function} incomingNoteFunc The function called when a note arrives. One parameter: the note. 
		 * @param {function} incomingRequestFunc The function called when a request arrives. Two parameters: the request, a callback to send the response. The latter takes at least the response as the parameter. responseFunc = (response, failureCode=0, opt={}, cbAck=(statusCode, statusMsg)=>{}); see the details below.
		 * @param {function} logger Optional, A function for loggin purposes: (logLevel, message)=>{}
		 * @param {object} opt Optional, the options object
		 * @param {boolean} opt.openOnConstruct Optional, default=true; is the connection open when the wsProcessor is created.
		 * @param {number} opt.heartbeatMinInterval Optional, default = 2; The minimum interval in seconds used for sending the heartbeats; 
		 * @param {number} opt.heartbeatRttIntervalMultiplicator Optional, default = 10; The minimum interval (as a multiplication with the current round trip time RTT from the last two heartbeats in seconds) used for sending the heartbeats; 
		 * @param {number} opt.heartbeatMinTimeout Optional, default = 10; The minimum time in seconds to wait for a pong, before the connection is deemed broken and is actively closed.  
		 * @param {number} opt.heartbeatRttTimeoutMutiplicator Optional, default = 50; The minimum time (as a multiplicator with the round-trip time RTT from the last two heartbeats in seconds) to wait for a pong, before the connection is deemed broken and is actively closed.
		 * @param {function} cbTest A function that is called on every incoming request and that is given the complete message. Intended only for testing; can be used to simulate a busy server (i.e. a slow responding server). The only property given is the parsed message. 
		 */
		constructor(sendingFunc, closingFunction, incomingNoteFunc, incomingRequestFunc, logger=(logLevel, msg)=>{}, opt={}, cbTest=(message)=>{}){
			// the constructor initializes everything (e.g. stacks) after the connection has been established
			this.stackNote = {}; // stack for acknowledged notes
			this.stackRequest = {}; // stack for any kind of requests
			this.stackResponse = {}; // stack for acknowledged responses 

			this.sendingFunc = sendingFunc; // the function that has to be called for sending messages; the wsProcessor class will call the sendingFunc with one argument: the message
			this.closingFunc = closingFunction;
			this.logger = logger;
			this.cbTest = cbTest;

			if (!("openOnConstruct" in opt)){
				opt.openOnConstruct = true;
			}
	
			// a variable to be set to true as soon as the connection is getting or is closed. It serves the purpose that the instance of this wsProcessor knows when it has no sense anymore to retry to send something. 
			// we assume that when this class is instantiated, the ws connection is not yet established (!)
			this.closing = true;

			// add functions to which the messages are passed to; they will be called with one or two arguments: (1): the message, (2): the function to be called to send the response (for request/response only; the argument is the message to be sent)
	
			this.incomingNoteFunc = incomingNoteFunc;
			this.incomingRequestFunc = incomingRequestFunc;

			// heartbeat 
			this.heartbeat = {};
			// the interval is given by max(minInterval, rrtIntervalMultiplicator*rtt)
			this.heartbeat.minInterval = opt.heartbeatMinInterval || 2; // s
			this.heartbeat.rttIntervalMultiplicator = opt.heartbeatRttIntervalMultiplicator || 10;
			// the timeout in which the answer must arrive is given by max(minTimeout, rrtTimeoutMultiplicator*rtt)
			this.heartbeat.minTimeout = opt.heartbeatMinTimeout || 10; // s
			this.heartbeat.rttTimeoutMultiplicator = opt.heartbeatRttTimeoutMutiplicator || 50;
			// the last and current rtt are just the last two rtt of the heartbeats, wher ethe pong came back, independent of their order 
			this.heartbeat.lastRTT = 0.1; // s
			this.heartbeat.currentRTT = 0.1; // s
			this.heartbeat.nSent = 0; // count the number of sent heartbeats (the counter is increased just before the next heartbeat is being sent)
			this.heartbeat.nLastArrived = 0; // remember the last arrived heartbeat --> write to logger, if the hertbeats do not arrive in the right order
			// Note: we actually do not create an interval (but a timeout), since the interval time is changing every time!
			this.heartbeat.sent = {}; // an object storing the sent heartbeats; the property is "H1" for the heartbeat with number 1 and so on
			this.heartbeat.timeoutNext = undefined; // the timeout to send the next heartbeat

			if (opt.openOnConstruct){
				this.open();
			}

		}

		// connection established
		open(){
			this.closing = false;

			this.sendHeartbeat();
		}

		/**
		 * Function to be called when the ws-connection is closing/closed
		 * @param {boolean} closeWsConnection Set to true, if the actual wsConnection shall be closed. Default=false, for the case when the wsConnection is already closed when this function is called.  (Only true if the connection shall be closed by the heartbeat-failure.) 
		 */
		close(closeWsConnection=false){

			if (this.closing){
				// if it is already closing, there is no need to run the function again. Rerunning this function happens when we call close after heartbeat failure (heartbeat failure --> wsProcessor close --> wsConnection close --> wsProcessor close)
				return; 
			}

			if (closeWsConnection){
				this.closingFunc();
			}

			this.closing = true;

			// stop the timout for the next heartbeat
			clearTimeout(this.heartbeat.timeoutNext);

			// stop the timeouts of the running heartbeats:
			for(let sHB in this.heartbeat.sent){
				//let nHB = Number(sHB.slice(1));
				clearTimeout(this.heartbeat.sent[sHB].timeout)
			}
			this.heartbeat.sent = {}; // probably faster than to delete every single item.

			// 'empty' (=call failure callbacks) all stacks 
			for (let stamp in this.stackNote){
				clearTimeout(this.stackNote[stamp].ackTimeoutHandle);
				this.stackNote[stamp].cbAck(1, "Connection closed before noteAck arrived.");
			}
			this.stackNote = {}; // faster than deleting single items

			for (let stamp in this.stackRequest){

				let stackObj = this.stackRequest[stamp];

				if (stackObj.ackTimeoutHandle){
					// requestAck requested but did not arrive yet
					clearTimeout(stackObj.ackTimeoutHandle);
					// the cbAck is not called here, since we directly call cbFailure

				} 
				
				clearTimeout(this.stackRequest[stamp].requestTimeoutHandle);

				if (stackObj.opt.sendAck){
					// ack was requested 

					if (stackObj.opt.ackArrived){
						stackObj.cbFailure(1.1, "Connection closed before response arrived, but after successful acknowledgement."); 
					} else {
						// differentiate timeout
						if (stackObj.opt.ackTimeout>0){
							// has/had a timeout
							if (stackObj.opt.ackTimedOut){
								stackObj.cbFailure(1.3, "Connection closed before response arrived and after the acknowledgement did not arrive within the timeout."); 
							}else{
								stackObj.cbFailure(1.2, "Connection closed before response arrived and before the acknowledgement timed out."); 
							}

						}else {
							// not timeout
							stackObj.cbFailure(1.2, "Connection closed before response arrived and before acknowledgement."); 
						}
					}
				} else {

					// no ack requested
					stackObj.cbFailure(1, "Connection closed before response arrived."); 

				}

				
			}
			this.stackRequest = {}; // faster than deleting single items

			for (let stamp in this.stackResponse){
				if (this.stackResponse[stamp].ackTimeoutHandle){
					clearTimeout(this.stackResponse[stamp].ackTimeoutHandle);
				}
				this.stackResponse[stamp].cbAck(1, "Connection closed before responseAck arrived.");
			}
			this.stackResponse = {}; // faster than deleting single items

			this.logger(0, 'The ws connection got closed.');

		}

		sendHeartbeat(){

			// number of this heartbeat
			let nHB = ++this.heartbeat.nSent;

			// create the object for the heartbeat
			let HB = {};
			this.heartbeat.sent['H'+nHB] = HB;

			// prepare the heartbeat
			var mess = {};
			mess.type = "ping";
			//mess.stamp = this.uuidv4(); // actually not really needed here, but soemwhere defined as a requirement
			mess.data = nHB;
			let messStr = JSON.stringify(mess);

			// set the current time right before sending the message, for an accurate RTT calculation
			let d = new Date();
			HB.time = d.getTime(); //get current time (milliseconds since 1.1.1970);

			// send
			this.sendingFunc(messStr);

			this.logger(4, `Ping sent ${nHB}` );

			// timeout for the current heartbeat (until when the pong has to arrive)
			let meanRtt = (this.heartbeat.lastRTT + this.heartbeat.currentRTT)/2;
			let timeoutThis = Math.max(this.heartbeat.minTimeout, this.heartbeat.rttTimeoutMultiplicator * meanRtt)*1000;
			HB.timeout = setTimeout(()=>{
				// remove the heartbeat
				delete this.heartbeat.sent['H'+nHB]

				this.logger(0, `Pong did not arrive within the timeout of ${timeoutThis/1000}s. Pong nbr: ${nHB}`);

				// close the wsProcessor and the ws connection (will also stop the other timeouts)
				this.close(true);

			}, timeoutThis)

			// set the timeout for the next heartbeat:
			let timeNext = Math.max(this.heartbeat.minInterval, this.heartbeat.rttIntervalMultiplicator * meanRtt)*1000;
			this.heartbeat.timeoutNext = setTimeout(()=>{
				this.sendHeartbeat();
			}, timeNext)


		}
	
		/**
		 * sendError: send an error message back to the client
		 * @param {string} error The error message to be sent 
		 */
		sendError(error){
			var mess = {};
			mess.type = "error";
			mess.data = error;
			let messStr = JSON.stringify(mess);
			this.logger(3, `Error sent per ws: ${messStr}` )
			this.sendingFunc(messStr);
		}
	
		/**
		 * sendNote: send a note with or without acknwoledgement to B. The parameters are mostly the same as for the response of a request
		 * On success (=message recieved by B and on ws-extended-level successfully parsed), the cbAck (errCode, errMsg) callback is executed with errCode=0. If the connection closes before the ack arrives, errCode=2. If there is no ack arriving within the given timeout (by default 5s), cbAck is called with errCode=1. 
		 * Failure codes:  
		 * - fail 1: ack does not arrive on time (to be handled here)
 		 * - fail 2: before timeout, the connection is deemed broken (to be handled in close)
		 * @param {string / binary} message The message to be sent as string or binary. 
		 * @param {object} opt Optional; Object storing parameters for the transmission.:
		 * @param {boolead} opt.sendAck Optional; default=false; Whether the request shall be acknowledged, i.e. cbAck callback is called with errCode=0 when the requestAck arrives. 
		 * @param {number} opt.ackTimeout (default=5s) The duration in seconds to wait for an ack. If the ack did not yet arrive after this duration, the chAck-callback is raised with code 1. 
		 * @param {callback} cbAck Only if opt.sendAck = true. A callback called when the requestAck arrives. ("err"Code, errMsg)=>{}. errCode = 0 if the ack arrived successfully. errCode=1 if cbAck is called due to the timeout (if set), errCode=2 if the connection is lost before the ack arrived.
		 */
		sendNote(note, opt={}, cbAck=(errCode, errMsg)=>{}){

			// initialize the options of the response
			opt.sendAck = opt.sendAck || false;
			opt.ackTimeout = opt.ackTimeout || 5; // The duration in seconds to wait for an ack. 

			var uuid = this.uuidv4(); // get the unique ID for this transmission
			// prepare message to be sent
			var mess = {}
			mess.type = "note"; // will be answered with noteAck, if everything goes as expected
			mess.sendAck = opt.sendAck;
			mess.stamp = uuid;
			mess.data = note;
			let messString = JSON.stringify(mess);
	
			if (opt.sendAck){
				// create everything needed to wait for the ack
				let stackObj = {}
				stackObj.cbAck = cbAck;
				stackObj.message = messString;
				stackObj.stamp = uuid;
				stackObj.opt = opt;
				this.stackNote[uuid] = stackObj;

				// start the timeout for the ack. In contrast to the request 
				stackObj.ackTimeoutHandle = setTimeout(()=>{

					let errMsg = `No ack arrived within the timeout (${opt.ackTimeout}s) of message ${stackObj.message}. `;
					stackObj.cbAck(2, errMsg)

					this.logger(1, errMsg) // write message to log. Only in debugging-mode, as in general the sending function should decide to log or not in the failure callback

					// delete the stackObject
					delete this.stackNote[uuid];

				},opt.ackTimeout*1000)

			}
			
			// send the message
			this.logger(3, `NoteAck sent per ws: ${messString}` )
			this.sendingFunc(messString);
		}

		/**
		 * sendRequest: send a request. wait for an answer for some seconds
		 * @param {string / object / binary} message The message to be sent as string or binary. 
		 * @param {callback} cbSuccess A callback with the response as parameter.
		 * @param {callback} cbFailure A callback with two parameters: errorCode (int), errorMessage (string)
		 * @param {object} opt Optional; Object storing parameters for the transmission.:
		 * @param {number} opt.requestTimeout Optional; default=10s; The duration in seconds to wait for the response. 
		 * @param {boolead} opt.sendAck Optional; default=false; Whether the request shall be acknowledged, i.e. cbAck callback is called with errCode=0 when the requestAck arrives. 
		 * @param {number} opt.ackTimeout (default=0=no timeout) The duration in seconds to wait for an ack. If the ack did not yet arrive after this duration, the chAck-callback is raised with code 1. This does NOT delete the request from the stack, i.e. the timeout for the actual request keeps running! The request is never stopped before the requestTimeout, connection failure or when the request arrives. 
		 * @param {callback} cbAck Only if opt.acknowledge = true. A callback called when the requestAck arrives. (errCode, errMsg)=>{}. errCode = 0 if the ack arrived successfully. errCode=1 if cback is called due to the timeout (if set)
		 */
		sendRequest (request, cbSuccess=(response)=>{}, cbFailure=(errCode, errMsg)=>{}, opt={}, cbAck=(statusCode, statusMsg)=>{}){

			// initialize the options of the request
			opt.requestTimeout = opt.requestTimeout || 10; // The duration in seconds to wait for an answer
			opt.sendAck = opt.sendAck || false;
			opt.ackTimeout = opt.ackTimeout || 0; // The duration in seconds to wait for an ack. 

			var uuid = this.uuidv4(); // get the unique ID for this transmission
			// prepare message to be sent
			let mess = {};
			mess.type = "request"; 
			mess.sendAck = opt.sendAck; 
			mess.stamp = uuid;
			mess.data = request;
			
			let messString = JSON.stringify(mess);

			// create the object for the stack: stores everything needed/defined in this message
			let stackObj = {};
			stackObj.cbSuccess = cbSuccess;
			stackObj.cbFailure = cbFailure;
			stackObj.cbAck = cbAck;
			stackObj.message = messString; 
			stackObj.stamp = uuid;
			
			stackObj.opt = opt;

			// add to stack
			this.stackRequest[uuid] = stackObj;

			// start the timeout until which the response must have arrived or otherwise the failureCB is raised
			stackObj.requestTimeoutHandle = setTimeout(()=>{
/*
				*      - fail 2: (1) request timed out
				*        - fail 2.1: (2+3) ... after ack arrived
				*        - fail 2.2: (2) ... before ack arrived
				*                    (3) ... before ack arrived and before ack timed out; this should not exist, since the ackTimeout should be smaller than the requestTimeout; thus, if the request times out, the ack already has timed out.
				*        - fail 2.3: (3) ... after ack timed out
*/
				let errMsg;
				if (stackObj.opt.sendAck){
					
					if (stackObj.opt.ackArrived){	
						errMsg = `No response arrived within the timeout (${opt.requestTimeout}s), after the ack did arrive of message ${stackObj.message}.`;
						stackObj.cbFailure(2.1, errMsg);
					} else {
						if (stackObj.opt.ackTimeout>0){
							// an ack timeout was set

							// when the request times out, the acknowledgement should actually already have timed out. However, check it here.
							if (stackObj.opt.ackTimedOut){
								errMsg = `No response arrived within the timeout (${opt.requestTimeout}s)  and also no ack arrived within the ackTimeout (${opt.ackTimeout}s) of message ${stackObj.message}. `;
								stackObj.cbFailure(2.3, errMsg);
							} else {
								// should not occure

								// delete the timeout
								clearTimeout(stackObj.ackTimeoutHandle);

								errMsg = `No response arrived within the timeout (${opt.requestTimeout}s), but the ackTimeout (${opt.ackTimeout}s) did not yet time out (should not happen, since the ackTimeout should always be smaller than the requestTimeout) of message ${stackObj.message}. `;
								stackObj.cbFailure(2.2, errMsg);
							}
							
						} else {
							// ack would have been requested (without timeout), but did not arrive
							errMsg = `No response arrived within the timeout (${opt.requestTimeout}s) and also no ack arrived so far of message ${stackObj.message}. `;
							stackObj.cbFailure(2.2, errMsg);
						}
					}

				} else {
					
					errMsg = `No response arrived within the request timeout (${opt.requestTimeout}s) of message ${stackObj.message}. `;
					stackObj.cbFailure(2, errMsg)

				}

				this.logger(1, errMsg) // write message to log. 

				// delete the object from the stack
				delete this.stackRequest[stackObj.stamp];

			}, opt.requestTimeout*1000)

			// add an additional property to keep track of the ackStatus
			if (opt.sendAck){
				opt.ackArrived = false;
			}

			// timeout for the ack if opt.ackTimeout>0
			if (opt.ackTimeout>0 && opt.sendAck){

				opt.ackTimedOut = false;

				stackObj.ackTimeoutHandle = setTimeout(()=>{
					let statusMsg = `No ack arrived within the timeout (${opt.ackTimeout}s) of message ${stackObj.message}. `;
					stackObj.cbAck(1, statusMsg)
	
					this.logger(1, statusMsg) // write message to log. Only in debugging-mode, as in general the sending function should decide to log or not in the failure callback

					// delete the ackTimeoutHandle
					delete stackObj.ackTimeoutHandle;

					// note that the ack timedout 
					opt.ackTimedOut=true;
	
				}, opt.ackTimeout*1000)
			}

			
			// finally, send the request
			this.logger(3, `Request sent per ws: ${messString}` )
			this.sendingFunc(messString);
		}
	
	
		/**
		 * uuidv4: Creates a unique ID according to RFC 4122, version 4. Credits go to: https://stackoverflow.com/questions/105034/create-guid-uuid-in-javascript#2117523
		 * This id shall be used for stamps.
		 */
		uuidv4() {
			return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function(c) {
					var r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
					return v.toString(16);
			});
		}
	
	
		// the function that processes the incoming messages
		_onMessage(messageRaw){
	
			/* 
			every message should have:
			- type: note, noteAck, request, requestAck, response, responseAck, ping, pong, error
			if needed also:
			- stamp: a unique hash
			*/
			
			this.logger(4, "Message recieved per ws: " + messageRaw); // can a  class access a global object
	
			var message = {}
			try{
				message = JSON.parse(messageRaw); 
			}catch(error){
				// send Error to client
				// use the error function
				let msg = `Message could not be parsed: ${messageRaw}`;
				this.sendError(msg);
				this.logger(0, msg)
			}
			if (!('type' in message)) {
				// the websocket request cannot be parsed without type and thus is simply dropped
				let msg = 'Message has no "type"-property and thus is deleted/dropped: ' + messageRaw ;
				this.logger(0, msg);
				this.sendError(msg);
				return;
			}

			// for testing: call the test-callback that will implement 'sleeping functions to test all the different failure possibilities and whether the respective callbacks are called
			// we must stop execution when a connection error shall be simulated, which is done by cbTest with returning true
			if (this.cbTest(message)){
				return;
			}
	
			var messagetypes = {
				note: ()=>{ 
					// process the message (make sure we did not already receive it!) and respond with noteAck

					if (message.sendAck){
						let respond = {};
						respond.type = "noteAck";
						respond.stamp = message.stamp;
						
						// acknowledge receiving the message
						this.sendingFunc(JSON.stringify(respond))

					}
					
					// process the message
					this.incomingNoteFunc(message.data);
				},
				noteAck: ()=>{
					// check validity
					if (!message.stamp){
						let msg = "NoteAck is not valid without stamp: " + messageRaw;
						this.sendError(msg);
						this.logger(0, msg)
					} else {

						if (message.stamp in this.stackNote){

							let stackObj = this.stackNote[message.stamp];

							// call the success-callback
							stackObj.cbAck(0, 'Note successfully acknowledged.');
							
							// stop the timeout and delete the open MessSyn-element in the queue
							clearTimeout(stackObj.ackTimeoutHandle);
							delete this.stackNote[message.stamp];

						} else {
							let msg = `Stamp ${message.stamp} was not on stack. This happens when 1) (unlikely) somebody tries to hack you or 2) (likely) the server was very busy and could not send you an answer within you default waiting time so you sent the requst again and the server finally also processed every request (n-1 times for nothing...) or 3) (little likely) two responses were sent for the same request and thus the request was already removed from the stack. It is not allowed to have more than one response (currently) and thus the now received (second or later) response is unhandled/deleted. Message: ${messageRaw}`
							this.logger(0, msg);
							this.sendError(msg);
						}
					}
				},

				// request sent to system B
				request: ()=> {

					// check that the request has a data and a stamp property.
					if ((message.data!=undefined) && (message.stamp!=undefined) ){

						//first check that the connection is available to send Ack; otherwise do not process the request
						if (this.closing){
							// in the very, very rare case where the conenctio is closed just after the request has arrived: just top it here. 
							return;
						}

						// check if ack is requested:
						if (message.sendAck){
							// send the ack:
							let ack = {
								type: 'requestAck',
								stamp: message.stamp,
							};
							let messageString = JSON.stringify(ack);
							this.sendingFunc(messageString);
						}

						// ---------------------------------
						// start processing:

						/**
						 * The response function to be called with the response or error to respond. The function handling the request can decide whether the response shall be acknowledged or not. The function is identical for incoming requests and requestSyn.
						 * @param {*} response The response to send
						 * @param {*} failureCode The error code (0=no error=default)
						 * @param {object} opt Optional; Object storing parameters for the transmission.:
						 * @param {boolead} opt.sendAck Optional; default=false; Whether the request shall be acknowledged, i.e. cbAck callback is called with errCode=0 when the requestAck arrives. 
						 * @param {number} opt.ackTimeout (default=5s) The duration in seconds to wait for an ack. If the ack did not yet arrive after this duration, the cbAck-callback is raised with code 1. 
						 * @param {callback} cbAck Only if opt.sendAck = true. A callback called when the requestAck arrives. (ackCode, ackMsg)=>{}. 
						 * 						   ackCode = 0 if the ack arrived successfully. 
						 *                         ackCode = 1* if the connection is lost before the ack arrived (important: see note below)
						 *                         ackCode = 2 if cbAck is called due to the timeout (if set), 
						 *                         ackCode = 3* if response cannot be sent since the connection is already closed
						 * 						   * NOTE: There can be cases where ackCode 1 is returned, despite the fact the response never arrived on the client (actual ackCode 3). This happens when the connection is actually already in closing/closed state, but this information did not yet arrive in the wsProcessor. This is due to synchronous handling on the server. Only if the request is processed async, there is the chance that the closing state gets processed before the response shall be sent. Event then, it significantly depends on how the async parts are defined!  
						 */
						let responseFunc = (response, failureCode=0, opt={}, cbAck=(statusCode, statusMsg)=>{})=>{

							// initialize the options of the response
							opt.sendAck = opt.sendAck || false;
							opt.ackTimeout = opt.ackTimeout || 5; // The duration in seconds to wait for an ack. 

							// prepare message to be sent
							let mess = {};
							mess.type = "response"; 
							mess.sendAck = opt.sendAck;
							mess.stamp = message.stamp;
							mess.data = response;
							mess.failureCode = failureCode;

							// TODO: delete for upload!
							// DEBUGGUNG for missing properties in the object and everything is fine until here?:
							// ATTENTION: sequelize adds toJSON functions to its objects, which overrides the default stringify process. Therefore, manually added properties are lost!
							// there are several ways to overcome the problem: 
							// - add a virtual property in the model:     newProp: {type: DataTypes.VIRTUAL, allowNull: false, defaultValue: false } OR
							// - add an instanceMethod in the model: sequelize.define('tablename', {properties}, {instanceMethods:{toJSON: function(){...}}})
							let messString = JSON.stringify(mess);


							// the stackObj is actually only used when the response shall be acknowledged
							let stackObj = {};

							if (opt.sendAck){
								stackObj.opt = opt;
								stackObj.stamp = message.stamp;
								stackObj.response = response; // only for debugging reasons
								stackObj.cbAck = cbAck;
								stackObj.message = messString; 
								this.stackResponse[message.stamp] = stackObj;
							}


							// check if there is a connection
							if (this.closing){
								
								cbAck(3, `The connection was closed before the response (${messString}) was sent.`)
								if (opt.sendAck){
									// clean up the stack
									delete this.stackResponse[stackObj.stamp];
								}
								return;
							}

							// start a timeout after which, without responseAck, failure is called
							if (opt.sendAck){
								stackObj.ackTimeoutHandle = setTimeout(()=>{

									let errMsg = `The following response timed out and is now considered failed: ${stackObj.message}`;
									this.logger(1, errMsg);
	
									stackObj.cbAck(2, errMsg) // failure callback
	
									// delete the object from the stack
									delete this.stackResponse[stackObj.stamp];
	
								}, opt.ackTimeout*1000);
							}

							// finally, send the request
							this.sendingFunc(messString);

						}

						// process the request
						this.incomingRequestFunc(message.data, responseFunc);

					} else {
						let msg = "Request is not valid without stamp and data properties: " + messageRaw;
						this.sendError(msg);
						this.logger(0, msg);
					}

				}, // end of requestSyn

				// acks sent to system A (the one that emmitted the request) during the request
				requestAck: ()=>{
					// acknowledgement, that the request has arrived on the server

					// the ack received should look like this
					/*let ack = {
						type: 'requestAck',
						stamp: message.stamp,
					};*/

					if (!('stamp' in message)){
						// the ack cannot be processed
						let msg = `Could not process requestAck because not all necessary properties were set: ${messageRaw}`;
						this.logger(0, msg);
						this.sendError(msg);
						return;
					}

					// find the request on the stack here
					let stackObj;
					if (stackObj = this.stackRequest[message.stamp]){

						// if there was an ackTimeout, check that this did not yet time out. Do NOT call the ack callback if it timed out already
						if (stackObj.opt.ackTimedOut){
							let msg = `Acknowledgement arrived after it has timed out. It is ignored. Stamp: ${message.stamp}`
							this.logger(0, msg)
							this.sendError(msg);
							return;
						}

						// call the status callback to let the requsting function know about the arrival of the request
						stackObj.cbAck(0, 'Request successfully acknowledged.');

						// stop the ackTimeout
						clearTimeout(stackObj.ackTimeoutHandle);

						// keep note about the arrived ack
						stackObj.opt.ackArrived = true;

					} else {
						// the ack cannot be processed
						let msg = `Could not process requestAck because it is not on the stack: ${messageRaw}`;
						this.logger(0, msg);
						this.sendError(msg);
						return;
					}
					
				},


				// response sent to system A
				response: ()=> {
					// a response to a request is received, process it and finally delete the request from the stack

					// check that the request has a data and a stamp property.
					if ((message.data!=undefined) && (message.stamp!=undefined)){

						// the stackObj should obviously already exist
						let stackObj;
						if (stackObj = this.stackRequest[message.stamp]){

							// stop the timeout
							clearTimeout(stackObj.requestTimeoutHandle);

							// check if ack is requested:
							if (message.sendAck){
								// send the ack:
								let ack = {
									type: 'responseAck',
									stamp: message.stamp,
								};
								let messageString = JSON.stringify(ack);
								this.sendingFunc(messageString);
							}

							// start processing the data
							
							// if the failurecode=0, everything is normal
							// if there was an error, the failurecode is the respective code and the response is the error-message as string.
							if (message.failureCode){ // failurecode is the statusCode; 0=no failure and the success-callback is called
								// call the failure callback
								stackObj.cbFailure(message.failureCode, message.data);
							}else{
								// call success callback
								stackObj.cbSuccess(message.data);
							}

							// remove from stack
							delete this.stackRequest[message.stamp];


						} else {
							// the ack cannot be processed
							let msg = `Stamp was not on stack. This happens when 1) (unlikely) somebody tries to hack you or 2) (likely) the server was very busy and could not send you an answer within your default waiting time so you sent the requst again and the server finally also processed every request (n-1 or even n times (when none of the replys came within the time between the first and the last request) for nothing...) or 3) (little likely) two responses were sent for the same request and thus the request was already removed from the stack. It is not allowed to have more than one response (currently) and thus the now received (second or later) response is unhandled/deleted. Message: ${messageRaw}`;
							this.logger(0, msg);
							this.sendError(msg);
							return;
						}

					} else {
						let msg = "Response is not valid without stamp and data properties: " + messageRaw;
						this.sendError(msg);
						this.logger(0, msg);
					}

				},

				// response ack sent to system B (that processed the request and sent the response)
				responseAck: ()=>{
					
					// the ack received should look like this
					/*let ack = {
						type: 'responseAck',
						stamp: message.stamp,
					};*/

					if (!('stamp' in message )){
						// the ack cannot be processed
						let msg = `Could not process responseAck because not all necessary properties were set: ${messageRaw}`;
						this.logger(0, msg);
						this.sendError(msg);
						return;
					}

					// find the request on the stack here
					let stackObj;
					if (stackObj = this.stackResponse[message.stamp]){

						// stop the timeout
						clearTimeout(stackObj.ackTimeoutHandle);

						// call success
						stackObj.cbAck(0, "Response successfully acknowledged.");

						// delete from the stack
						delete this.stackResponse[stackObj.stamp];

					} else {
						// the ack cannot be processed
						let msg = `Could not process responseAck because it is not on the stack: ${messageRaw}`;
						this.logger(0, msg);
						this.sendError(msg);
						return;
					}

				},

				error: ()=> {
					this.logger(1, 'A client returned an error for a ws-package: ' + message.data.toString());
				},

				ping: ()=>{
					// directly send back the pong
					let respond = {};
					respond.type = "pong";
					//respond.stamp = this.uuidv4(); // actually not really needed here, but soemwhere defined as a requirement
					respond.data = message.data;
					this.sendingFunc(JSON.stringify(respond));

					this.logger(4, `Ping ${message.data} arrived. Pong sent.`); 
				},

				pong: ()=>{

					// get the correct heartbeat object
					let HB = this.heartbeat.sent['H'+message.data];
					if (HB===undefined){
						// prevent an application failure on incorrect messages arriving
						this.logger(1, 'Pong message did not match a sent ping. Pong is ignored.')  
						return;
					}

					// calculate the RTT
					let d = new Date();
					let rtt = d.getTime() - HB.time; // in ms

					// delete the heartbeat-timeout
					clearTimeout(HB.timeout)

					// modifiy lastRTT and currentRTT
					this.heartbeat.lastRTT = this.heartbeat.currentRTT;
					this.heartbeat.currentRTT = rtt/1000; // must be in s!

					// set new nLastArrived and write to log if a/multiple heartbeat was skipped 
					if (this.heartbeat.nLastArrived+1 != message.data){
						this.logger(1, `Pong ${message.data} arrived out of order. Last pong was ${this.heartbeat.nLastArrived}`);
					}
					this.heartbeat.nLastArrived= message.data;

					// delete the heartbeat from heartbeat.sent
					delete this.heartbeat.sent['H'+message.data]

					this.logger(4, `Pong ${message.data} arrived within ${rtt} ms.`); 

				}
			}
	
			if (typeof(messagetypes[message.type]) == 'function'){
				messagetypes[message.type]()
			} else {
				this.logger(1, message.type + ' is not a supported type of WebSocket data.');
			}
	
		}
	
	}
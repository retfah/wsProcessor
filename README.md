# wsProcessor
A lightweight processor for websocket connections, providing acknowledged messages, error handling and connection status monitoring.

![npm](https://img.shields.io/npm/dm/wsprocessor)
![GitHub file size in bytes](https://img.shields.io/github/size/retfah/wsProcessor/browser/wsProcessorBrowser.min.js?label=minified%20size)

Written in pure javascript and without any dependency. The same code runs with any websocket implementation, e.g. [ws](https://www.npmjs.com/package/ws) for [nodejs](https://nodejs.org/) and the [Websocket API](https://developer.mozilla.org/en-US/docs/Web/API/WebSockets_API) in modern browsers. 

## Features

* basically three types of messages: **requests**, which will be answered with a **response** and **notes** for messages that do not need an answer
* **acknowledgement** (optional) for requests, response and notes
* **callbacks** for **success**, acknowledegement **status** and **errors** (during processing on the server, due to connection loss and or caused by request timeouts)
* connection loss monitoring through **heartbeats** (ping/pong)
* various configuration **options**
* **logging**
* distinct **error codes**
* extensively **commented** code

## Installation

The package can be downloaded from [github](https://github.com/retfah/wsProcessor) or installed with npm: 
```bash
npm install wsProcessor
```

There are mainly three files of interest: 
- the nodejs module (wsProcessor.cjs)
- the minified browser version (browser/wsProcessorBrowser.min.js)
- the regular browser version (browser/wsProcessorBrowser.js)

## Philosophy
Basically two kinds of messages can be sent with the wsProcessor: 
* **notes** (```wsProcessor.sendNote(note)```): notify the receiver about something, as used e.g. for broadcasts. 
* **requests** (```wsProcessor.sendRequest(request, successCB, failureCB)```): request something from the receiver; a successful response will be handed over to successCB (```successCB=(message)=>{}```), while errors result in a call to failureCB (```failureCB=(errCode, errMsg)=>{}```) with distinct error codes. 

On the receiver, both kinds of messages are handled in their corresponding functions, which are provided to the constructor. The note callback only takes the message as a parameter. The request callback additionally provides the response function as it second parameter, which is to be called to send the response. 

wsProcessor is independent of the actual websocket implementation and works as a layer between the application and the websocket connection. Therefore, the websocket connection is established outside the wsProcessor. All incoming messages shall then be directed to ```wsProcessor.onMessage(message)```. The wsProcessor processes the rawMessages and calls the note or request callback, respectively. To tell the wsProcessor how to send messages and close the connection, two functions (```sendingFunc(message)``` and ```closingFunc()```) must be provided to the constructor. 


wsProcessor uses timeouts to raise errors when an answer to a message does not arrive within a certain period of time. By default, a request is deemed failed when there is no response within 10s. The default can be overriden separately for each request. Notes and requests provide the possibility for acknowledgements, which the answering party sends as soon as the note or request has arrived and before it is processed. the default timeout for note acknowledgements is 5s. It can be overriden for each separately for each request, response and note. By default, the request has no timeout for the acknowledgement, meaning that it times out together with the request itself. 

To track the connection status, heartbeats (ping) are sent from time to time. The interval is given by the larger of ```opt.heartbeatMinInterval``` (default: 2s) and the product of the average round trip time (RTT) of the two last hearbeats and ```opt.heartbeatRttIntervalMultiplicator``` (default: 10). If the heartbeat (ping) is not responded (pong) within a certain period of time, the connection is deemed failed. The timeout is defined by the larger of ```opt.heartbeatMinTimeout``` (default: 10s) and the product of the average round trip time (RTT) of the two last hearbeats and ```heartbeatRttTimeoutMutiplicator```. 

If the connection gets closed, the failure callbacks of all hanging requests and notes are called with the corresponding error code and message. 

**NOTE**: All error codes, parameters and options are well documented above every function in the code. 

## Example (node)
NOTE: A slightly more elaborate example can be found on [github](https://github.com/retfah/wsProcessor/tree/main/example). It additionally provides an express server to deliver the browser code. On the browser, every request, response, note and log entry is displayed. 

To react on incoming requests and notes, your code must provide handlers:
```js
function requestHandler(request, responseFunc){
	// ... process the request ...
	
	// send the successful response (error code 0)
	responseFunc('the response')
	
	// OR an error: 
	responseFunc('The error message', errorCode)
}

function noteHandler(note){
	// ... process the note ...
}
```

Optional: If the responder must know whether the response was successfully sent, an acknowledgement can be requested, which will then call the provided callback.: 
```js
opt = {
	sendAck: true, // optional; default=false; Whether the request shall be acknowledged, i.e. cbAck callback is called with errCode=0 when the requestAck arrives. 
	ackTimeout: 5 // optional; default=5s; The duration in seconds to wait for an ack. If the ack did not yet arrive after this duration, the cbAck-callback is raised with code 1.
}
function cbAck(statusCode, statusMsg){
	if (statusCode==0){
		// ... response successfully arrived ...
	} else {
		// ... response not acknowledged
	}
}
responseFunc(response, errorCode, opt, cbAck)
```

The websocket connection is established outside the wsProcessor. (The example uses [ws](https://www.npmjs.com/package/ws) for the Websocket server.) When the websocket connection is opened, create the wsProcessor. The constructor of the wsProcessor expects the two handler functions for requests and notes as well as a function for sending messages and a function to close the connection. Optionally, a logger function and an object with options can be provided. 
```js
const wsProcessor = require('wsprocessor')
const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 3300 });

wss.on('connection', (ws)=>{
	
	// required callbacks
	let sendCB = (message)=>{
		ws.send(message);
	}
	let closeCB = ()=>{
		ws.close();
	}
	
	// optional:
	let logger = (logLevel, msg)=>{
		// see the definition of the log levels at the top of the code
		// ... process the log messages here, eventually translate to your own codes ... 
	}
	
	let opt = {
		openOnConstruct: true, // optional; default=true; is the connection already open when the wsProcessor is created. If false, call wsProcessor.open() as soon as the connection is open.
		heartbeatMinInterval: 2, // optional; default = 2; the minimum interval in seconds used for sending the heartbeats; 
		heartbeatRttIntervalMultiplicator: 10, // optional; default = 10; the minimum interval (as a multiplication with the current round trip time RTT from the last two heartbeats in seconds) used for sending the heartbeats; 
		heartbeatMinTimeout: 10, // optional; default = 10; the minimum time in seconds to wait for a pong, before the connection is deemed broken and is actively closed. 
		heartbeatRttTimeoutMutiplicator: 50 // optional; default = 50; the minimum time (as a multiplicator with the round-trip time RTT from the last two heartbeats in seconds) to wait for a pong, before the connection is deemed broken and is actively closed.
	}
	
	const processor = new wsProcessor(sendCB, closeCB, noteHandler, requestHandler, logger, opt); // the last two parameters are optional
	
	ws.on('message', (message)=>{
		processor.onMessage(message);
	});
	ws.on('close', ()=>{
		processor.close();
	})
})
```

## Example (browser)

The wsProcessor is included in the header:
```html
<script src="/wsProcessorBrowser.min.js" type="text/javascript"></script>
```

Since the wsProcessor code is exactly the same as in nodejs, all the options mentioned above are valid in the browser as well. The following code provides a minimal exanmple on how to apply the wsProcessor in the browser. The main difference between ws for nodejs and the Websocket API in browsers is how the events (onConnection, onMessage, onClose, onError) are handled.  
```js
function requestHandler(request, responseFunc){
	// ... process the request ...
	
	// send the successful response (error code 0)
	responseFunc('the response')
	
	// OR an error: 
	responseFunc('The error message', errorCode)
}

function noteHandler(note){
	// ... process the note ...
}

var processor;
var connection = new WebSocket("ws://localhost:3300");

let sendCB = (message)=>{connection.send(message);}
let closeCB = ()=>{connection.close();}

connection.onopen = (event)=>{
	processor = new wsProcessor(sendCB, closeCB, noteHandler, requestHandler);
}

connection.onmessage = (mess)=>{processor.onMessage(mess.data);};
connection.onclose = (event)=>{processor.close();};
connection.onerror = (event)=>{processor.close();}; 

```

## Background: 

### How WebSockets and TCP work; especially how connection errors are detected
TCP: 
- opens a connection between client and server, which in the case of ws is kept open. 
- Starting up the connection is acknowledged (Syn, Syn/Ack, Ack), as well as every piece of data sent through the tcp connection. 
- TCP does not necessarily have heartbeat signal to realize when the connection has failed. In contrast: it might try for hours to connect to a unreachable server or resend some data without raising an error to the calling application. 
- Heartbeats basically exist in the form of TCP-keep-alive packages, which can help to notify routers between both ends to keep the connection open. (Note that this might be e.g. important for NAT-Routers.) In an experimental investigation with wireshark the same browser/OS combination on two different computers once "never" (>several minutes) sent keep-alive packages, while the other sent one every 45s. Additionally, I don't know whether a connection error would be raised on keep-alive-ack-failure or not. So we cannot rely on tcp to detect a connection error. If e.g. a network cable was removed on one side, this computer might raise on error, since removing the cable is electrically realized. (Exemplary investigation: the browser does not realize it or at least does not change the ready-state of the ws-connection.) The other end of the connection woudl not realize it (=> the connection is then called half-open). 
- The only way, how a failed tcp-connection can be detected if by some sort of heartbeats/keep-alive packages and timeouts. See e.g. [here](https://www.codeproject.com/Articles/37490/Detection-of-Half-Open-Dropped-TCP-IP-Socket-Conne).

WebSocket: 
- [RFC 6455](https://tools.ietf.org/html/rfc6455)
- [Websocket API (in browsers)](https://html.spec.whatwg.org/multipage/web-sockets.html)
- Connection is established through an "Upgrade" from a regular http connection, which is tcp as well. The underlying tcp connection will then be kept open. 
- WS knows 4 states (in Websocket API in browsers called readyState, number in parantheses: CONNECTING (0), OPEN (1), CLOSING (2); CLOSED (3). It is connecting dureing the handshakes at the beginning and then open. As soon as one client wants to close the connection, the status on the client is closing, until the closing ack arrives at the client again, when the status changes to closed. 
- WS defines special ping and pong frames, meant to check the connection state. An incoming ping frame MUST be answered with pong. In the WsApi used in browsers, it is unfortunately not possible yet (2021-03) to send pings or raise an event on incoming pings. Therefore, the ping/pong must be implemented in wsProcessor!
- Unfortunately, ws does not raise an error if sending a request fails (or at least it is not documented). Probably because it would first retry sending for some undocumented time.
- Experiment: removing the ethernet cable does not change the state of the connection (still OPEN...). It took roughly 18 seconds after "sending" (actually trying to send) a message over the dead connection until the onerror/onclose event was raised. This shows again, that some kind of heartbeam must be implemented in wsProcessor.
- Experiment: shutting down or killing the server (on Windows) is NOT equivalent to a detached cable! It seems that the sockets handling is done by the OS and killing the server means that the reserved port gets free and the socket related to it are closed with a final RST/ACK (i.e. not a normal closing, but a least a message is sent). This leads to a termination of the connection on the client, which is not the same as if the cable was detached, where no closingEvent would be raised. 

=> Based on those findings, the wsProcessor was created. Since there is (at least) no browser API that would expose ping/pong functionality, the wsProcessor implements its own heartbeats (ping/pong) to trace a connection loss. 

## License: 
[LGPL-3.0-or-later](https://www.gnu.org/licenses/lgpl-3.0.txt)
// Server for testing the wsExtension

// include all the necessary packages
var express    	=   require('express');
var wsServer	= 	require('ws').Server;		// websocket server
var wsProcessor       =   require('../'); // 

//debugger;


// ----------------
// Setup the app
// ----------------

// generate the express server
var app        =    express();

// serve static files (URL must be "/static" and the files lie in "/static")
app.use('/static', express.static('static'))

app.get('*', (req, res, next)=>{
    res.redirect('/static/wsExample.html')
})


// listen on port 3300, automatically http
var server     =    app.listen(3300);

// start the bare websocket Server
const wss = new wsServer({server:server, port:3301});

// the server was established already above
wss.on('connection', (ws)=>{ // ws is the websocket object

    console.log('Websocket connection opened.')

	/**
	 * noteHandling: in this example-test server, we simply log the note message and send the same message back to the client
	 * @param {any} note The data that was sent. could be any datatype, as defined on client and server as soon it is used. 
	 */
	var noteHandling = (note)=>{
        console.log(`Note arrived and sent back: ${note}`);
        processor.sendNote(note);
	}

	/**
	 * requestHandling: handles the incoming requests. Must have two arguments, so it can be used in the wsProcessor directly. 
	 * @param {json} request The sent request
	 * @param {function(response, failureCode=0, acknowledged=false, failure=(errCode, errMsg)=>{}, success=()=>{})} responseFunc The function that has to be called with the response as the first argument. If an error shall be reported, the second argument must be true and the first parameter is the error-message.
	 */
	var requestHandling = async function(request, responseFunc){ 

        if (request.type=="square"){

            console.log(`Request to square ${request.value} arrived.`)

            // square the sent number and respond with acknowledged response
            let square = request.value**2;

            responseFunc(square, 0,  {sendAck:true}, (ackCode, ackMsg)=>{
                console.log(`Response ack status: ${ackCode} - ${ackMsg}`)
            })

        } else if (request.type=="error"){

            console.log(`Request an error!`)

            // return an error unacknowledged; error code 13. 
            responseFunc("Some error ;,-( ", 13, (responseErrorCode, responseErrorMsg)=>{
                // there is hopefully no error in sending the response.
                console.log(`Error sending "error 13" to a request: ${responseErrorCode} - ${responseErrorMsg}`);
            })
        } 

	}

	// create the wsProcessor instance
    // sendingFunc, closingFunction, incomingNoteFunc, incomingRequestFunc, logger=(logLevel, msg)=>{}, opt={}
	const processor = new wsProcessor((mess)=>{ws.send(mess);},()=>{ws.close()}, noteHandling, requestHandling, (logLevel, msg)=>{}, {heartbeatMinTimeout: 30});

	// link the websocket events with the wsExtension
    ws.on('message', (mess)=>{
        processor.onMessage(mess);
    });
	ws.on('close', ()=>{
		processor.close();
        console.log('the ws connection is closed.')
	})

})

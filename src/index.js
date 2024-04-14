const pjson = require('../package.json');
const express = require('express');
const ws = require('ws');
const url = require('url');
const querystring = require('querystring');
const fs = require('fs');
const { BlobServiceClient } = require("@azure/storage-blob");

let serverPort = process.env.PORT;
if(!serverPort)serverPort=3000;
const pendingFlushes = {};

console.log("setting up logging system...");
const winston = require('winston');
const {Loggly} = require('winston-loggly-bulk');
const logglyToken = process.env.logglyToken;
logInfo("found logglyToken = " + logglyToken);
if(logglyToken) {
  winston.add(new Loggly({
      token: logglyToken,
      subdomain: "gr4per",
      tags: ["Winston-NodeJS nms"],
      json: true
  }));

  console.log("nms connected to loggly!");
}

function logInfo() {
  if(logglyToken) {
    let args = Array.from(arguments);
    args.unshift("info");
    try {
      winston.log.apply(winston, args);
    }
    catch(e) {
      console.error("loggly unavailable " + e);
    }
    console.log.apply(console, arguments);
  }
  else console.log.apply(console, arguments);
}
function logError() {
  if(logglyToken) {
    let args = Array.from(arguments);
    args.unshift("error");
    try {
      winston.log.apply(winston, args);
    }
    catch(e) {
      console.error("loggly unavailable " + e);
    }
    console.error.apply(console, arguments);
  }
  else console.error.apply(console, arguments);
}

logInfo("version = " + pjson.version);
logError("test error");
const app = express();
const bodyParser = require('body-parser');
const cors = require('cors');
app.use(cors());
app.use(bodyParser.json());
const nmConnections = [];

process.on('SIGINT', exitGracefully);

process.on('SIGTERM', exitGracefully);

async function exitGracefully(signal) {
  logInfo("received signal " + signal + ". flushing buffers...");
  await flushBuffers();
  logInfo("buffers flushed, exiting");
  process.exit(0);
}

let nmCreds = null
try {
  nmCreds = require("./../creds.json");
}
catch(e) {
  console.log("./../creds.json not found, trying to get from env...");
}
if(!nmCreds){
  nmCreds = process.env.creds; // object mapping nmId to {pass:...., token:....}
  if(nmCreds) {
    nmCreds = JSON.parse(nmCreds);
  }
}

let uidCounter = 0;
function getNMConnectionId() {
  return uidCounter++;
}

// Set up a headless websocket server that prints any
// events that come in.
function formatSocket(socket) {
  return " port " + socket.localPort + " from remote " + socket.remoteAddress;
}

function noop() {}

const wsServer = new ws.Server({ noServer: true });
wsServer.on('connection', (ws, request) => { // emitted after handle upgrade 
  logInfo("connection event on wsServer, socket : " + formatSocket(request.socket));
  
  let nmConnection = nmConnections.find(e=>{return e.socket == ws;});
  if(!nmConnection) {
    logError("connection event without related nmConnection");
    return;
  }
  logInfo("connection found: " + nmConnection);
  nmConnection.sendError = (error) => {
    logInfo("sending error to nmp " + nmConnection.nmId + ": " + error);
    ws.send(JSON.stringify({error:error}));
  };
  if(!nmConnection) {
    logError("failed to locate nmConnection on socket " + formatSocket(request.socket));
    ws.destroy();
    return;
  }
  //logInfo("found nmConnection["+nmConnection.id+"], nmId " + nmConnection.nmId + ", nmdId " + nmConnection.nmdId);
  ws.send(JSON.stringify({command:"id",params:[nmConnection.id,pjson.version]}));
  if(nmConnection.error) {
    logInfo("nmConnection is in error state, sending error to client before socket termination.");
    ws.send(JSON.stringify({error:nmConnection.error}));
    removeNm(nmConnection);
  }
  ws.on('error', (e) => {
      logInfo("received error on websocket of nm " + nmConnection.nmId + ", connected to nmd " + nmConnection.nmdId + ": " + e);
      nmConnection.error = e;
  });
  ws.on('pong', (e) => {
    //logInfo("received pong from nmConnection of " + nmConnection.nmId);
    nmConnection.isAlive=true;
  });
  ws.on('message', message => {
    //logInfo("rcvd msg from " + nmConnection.nmdId + ": " + message);
    let messageObj = null;
    try {
      messageObj = JSON.parse(message);
    }
    catch(e) {
      logInfo("not a JSON msg, wrapping as newMeasurement");
      messageObj = {command:"newMeasurement", params:[message]};
    }
    switch(messageObj.command) {
      case "clientPing":
        nmConnection.isAlive=true;
        ws.send(JSON.stringify({command:"pong"}));
        break;
      case "leave":
        logInfo("nm " + nmConnection.nmId + " is leaving nmd, remove from nms = " + messageObj.params[0]);
        nmConnection.isAlive=false;
        removeNm(nmConnection, messageObj.params[0]);
        break;
      case "newMeasurement":
        logInfo("nmConnection[" + nmConnection.id + "] is posting new measurement for nmd " + nmConnection.nmdId + "...");
        if(nmConnection.mode != "source"){
          logError("nmc[" + nmConnection.id + "] is not a source. Aborting");
        }
        else {
          newMeasurement(nmConnection.nmdId, messageObj.params[0]);
        }
        break;
      case "sync":
        logInfo("nmc[" + nmConnection.id + "] is requesting sync for nmd " + nmConnection.nmdId + " from " + messageObj.params[0]);
        if(nmConnection.mode != "sink"){
          logError("nmc[" + nmConnection.id + "] is not a sink. Aborting");
        }
        else {
          syncNMC(nmConnection, messageObj.params[0]);
        }
        break;
      
      default:
        logInfo("Not implemented! Received command " + messageObj.command + " from nm " + nmConnection.nmId);
    }
  });
  if(nmConnection.status == "joining" && nmConnection.mode == "source") {
    // send init command to source
    let bufferLines = [];
    if(nmdsList[nmConnection.nmdId].currentBuffer) {
      bufferLines = nmdsList[nmConnection.nmdId].currentBuffer.split("\r\n").filter(l => {return l.length>0;});
    }
    let lastLine = null;
    if(bufferLines.length > 1)lastLine = bufferLines[bufferLines.length-1];
    let lastTime = null;
    if(lastLine != null)lastTime = lastLine.substring(0,19)+".000Z";
    logInfo("sending stream command to nmd source " + nmConnection.id + " on nmd " + nmConnection.nmdId + ", lastTime = " + lastTime);
    ws.send(JSON.stringify({command:"stream",params:[lastTime]}));
    nmConnection.status = "joined";
  }
  //updateNMCs(nmConnection.nmdId);
});

function removeNm(nmConnection, nmdId) {
  let idx = nmConnections.indexOf(nmConnection);
  nmConnections.splice(idx,1);
}

function syncNMC(nmConnection, tsStr) {
  let nmd = nmdsList[nmConnection.nmdId];
  let clientPointer = new Date(tsStr+".000Z"); // this is referring to UTC of course
  nmConnection.nmcPointer = clientPointer;
  nmConnection.sycStatus = "syncing";
  logInfo("clientPointer [" + nmConnection.id + "] = " + clientPointer);
  let lines = nmd.currentBuffer.split("\r\n").filter(l=>{return l.length >2;});
  logInfo("buffer currently has " + lines.length + " lines.");
  let outgoing = "";
  let newClientPointer = clientPointer;
  let earliestLineSynced = clientPointer;
  for(let i = lines.length-1;i >0; i--) { // i > 0 to make sure we dont process the csv header
    let dataTime = getCsvTime(lines[i]);
    if(dataTime.getTime() <= clientPointer.getTime()) {
      logInfo("time " + dataTime + " of line " + i + " before clientPointer, stopping collection");
      break;
    }
    earliestLineSynced = dataTime;
    outgoing = lines[i] + "\r\n" + outgoing;
    newClientPointer = dataTime;
  }
  try {
    nmConnection.socket.send(outgoing);
    nmConnection.nmcPointer = newClientPointer;
    nmConnection.syncStatus = "live";
    logInfo("nmConnection["+nmConnection.id+"].syncStatus set to live. ts = " + tsStr + ", latest buffer line synced " + newClientPointer + ", earliest line " + earliestLineSynced);
  }
  catch(e) {
    logError("failed to sync nmConnection[" + nmConnection.id + "]", e);
  }
}

// new measurement payload is a multi line string with one measurement per row
function newMeasurement(nmdId, data) {
  let nmd = nmdsList[nmdId];
  if(!nmd) {
    logError("cannot add newMeasurement to nmdId " + nmdId + ", not found!");
    return;
  }
  let chunks = []; // string array
  let currentChunkFileName = "";
  //logInfo("newData: " + data);
  let rows = data.split("\r\n").filter(l=>{return l.length > 0;});
  for(let l of rows) {
    let dataTime = getCsvTime(l);
    let fileName = getFileName(dataTime);
    if(fileName != currentChunkFileName) {
      logInfo("adding chunk " + fileName +  " based on dataTime " + dataTime);
      currentChunkFileName = fileName;
      chunks.push("");
    }
    chunks[chunks.length-1] += l+"\r\n";
  }
  logInfo("received new data from nmd " + nmd.nmdId + ", " + chunks.length + " chunks.");
  
  for(let i = 0; i < chunks.length; i++) {
    let dataTime = new Date(chunks[i].substring(0,data.indexOf("\t"))+".000Z"); // this is row 0
    let targetFileName = getFileName(dataTime);
    logInfo("currentFileName on " + nmd.nmdId + " = " + nmd.currentFileName + ", targetFileName = " + targetFileName + " based on chunk start time " + dataTime);
    if(nmd.currentFileName == targetFileName) {
      // add new data to current buffer
      nmd.currentBuffer += chunks[i];
      // if not flushed since 60s
      if(!nmd.lastFlush || new Date().getTime() - nmd.lastFlush.getTime() > 60000) {
        logInfo("flushing buffer " + nmd.nmdId + " due to timeout 60s. lastFlush: " + nmd.lastFlush);
        flushNmdBuffer(nmd); // this will slice the buffer before long running write to blob, so we can already replace it
        nmd.lastFlush = new Date(); // make sure we dont retrigger while the flush is running
      }
    }
    else {
      // flush current buffer
      logInfo("flushing chunk[" + i + "] to " + nmd.currentFileName + " due to fileName change.");
      flushNmdBuffer(nmd); // this will slice the buffer before long running operations, so we can already replace it
      
      // create new buffer
      nmd.currentBuffer = getCSVHeader();
      nmd.currentBuffer += chunks[i];
      nmd.currentFileName = targetFileName;
      logInfo("updated nmd to point to new file " + nmd.currentFileName + " and initialized with CSV header");
    }
    // only send last two hours to NMCs
    let line0 = chunks[i].substring(0,20);
    let chunkTime = getCsvTime(line0);
    if(chunkTime.getTime() > new Date().getTime()-3600*3*1000) {
      logInfo("sending chunk " + i + ", startTime " + chunkTime + " to clients");
      updateNMCs(nmdId, chunks[i]);
    }
    else {
      logInfo("chunk " + i + ", startTime " + chunkTime + " too early, not bothering clients");
    }
  }
}

function getCsvTime(csvLine) {
  return new Date(csvLine.substring(0,csvLine.indexOf("\t"))+".000Z");
}
const interval = setInterval(function ping() {
  for(let nmc of nmConnections) {
    if(nmc.status == "joining" && (new Date().getTime() - nmc.timestamp.getTime()) > 5000) {
       logInfo("" + new Date() + ": found stale " + nmc.mode + " nmConnection[" +nmc.id+"] to nmd " + nmc.nmdId + ", last updated " + nmc.timestamp);
       nmc.socket.terminate();
    }
    else {
      if (!nmc.isAlive){
        logInfo("nmConnection[" + nmc.id + "] to nmd " + nmc.nmdId + " is not alive, terminating.");
        nmc.socket.terminate();
        nmConnections.splice(nmConnections.indexOf(nmc),1);
        let nmd = nmdsList[nmc.nmdId];
      }
      else {
        nmc.isAlive = false;
        //logInfo("pinging socket of " + nmc.nmId + " to nmd " + nmc.nmdId);
        nmc.socket.ping(noop);
      }
    }
  }
}, 5000);

async function updateNMCs(nmdId, newData) {
  let conns = nmConnections.filter(pc=>{return pc.nmdId == nmdId && pc.mode == "sink" && pc.syncStatus == "live";});
  logInfo("broadcasting nmd data update of nmd " + nmdId + " to " + conns.length + " clients...");
  let nmd = nmdsList[nmdId];
  if(!nmd) {
    logError("cannot update nmdState of nmd " + nmdId + ", not found!");
    return;
  }
  for(let con of conns) {
    try {
      if(con.status == "joined") {
        con.socket.send(newData);
      }
      else {
        logInfo("nmConnection[" + con.id + "] is flushing, skipping update");
      }
    }
    catch(e) {
      logInfo("failed to send data to " + con.id + ": " + e);
    }
  }
}

async function flushNMC(nmConnection) {
  let nmd = nmdsList[nmConnection.nmdId];
  //logInfo("flushing current buffer, fileName " + nmd.currentFileName + " to nmConnection["+nmConnection.id+"]");
  //nmConnection.socket.send(nmd.currentBuffer);
  nmConnection.status = "joined";
  nmConnection.syncStatus = "idle";
}

// `server` is a vanilla Node.js HTTP server, so use
// the same ws upgrade process described here:
// https://www.npmjs.com/package/ws#multiple-servers-sharing-a-single-https-server
const server = app.listen(serverPort);
server.on('upgrade', (request, socket, head) => {
  //logInfo("websocket request is being upgraded");
  //logInfo("method:" + JSON.stringify(request.method));
  //logInfo("headers:" + JSON.stringify(request.headers));
  //logInfo("url:" + JSON.stringify(request.url));
  let requestURL = url.parse(request.url);
  //logInfo("requestURL:" + JSON.stringify(requestURL));
  let path = requestURL.pathname;
  let query = querystring.parse(requestURL.query);
  //logInfo("path:" + JSON.stringify(path));
  //logInfo("query:" + JSON.stringify(query));
  let nmdFound = false;
  if(path.startsWith("/api/nmds/") && path.length > 11 && path.endsWith("/join")) {
    let nmdId = path.substring(10,path.indexOf('/',10));
    //logInfo("nmdId = " + nmdId);
    if(!nmdsList[nmdId]) {
      logError("nmd " + nmdId + " not found"); 
    }
    else {
      nmdFound = true;
    }
    let nmId = query.nmId;
    //logInfo("nmId = " + nmId);
    //logInfo("setting handle upgrade to deal with ws request");
    wsServer.handleUpgrade(request, socket, head, socket => {
      //logInfo("upgrade negotiated, socket = " + JSON.stringify(request.socket.remoteAddress));
      let nmConnection = null;
      if(query.mode == "source") {
        let pcc = nmConnections.filter(p=>{return p.nmdId == nmdId && p.mode == query.mode;});
        if(pcc.length == 1) { // replace
          logInfo("found existing connection of nmpi " + nmdId + ": " + JSON.stringify(
            pcc.map(
              (e)=>{return {id:e.id, nmdId:e.nmdId, status:e.status, isAlive:e.isAlive, statusTime:e.statusTime};}
            )
          ));
          logInfo("newly connecting nmd has existing nmd connection");
          if(pcc[0].isAlive) {
            // verify connection
            logInfo("existing connection isAlive!");
          }
          nmConnection = pcc[0];
          nmConnection.socket = socket;
        }
        else if(pcc.length == 0) {
          nmConnection = {id:getNMConnectionId(), socket:socket,status:"joining",statusTime:new Date(), isAlive:true, nmdId:nmdId, mode:"source"};
          nmConnections.push(nmConnection);
          logInfo("created new source nmConnection[" + nmConnection.id + "] for nmd " + nmdId);
        }
        else {
          logError("More than 1 connection for nmd " + nmdId + " source: " + JSON.stringify(pcc));
          return;
        }
        // in any case we have now a new or re-established connection to an nmd
        // for the case that this is due to restart of nms service, we might have lost data during down time and should ask the nmd to continue 
        // sending data from a certain point in time
      }
      else {
        nmConnection = {id:getNMConnectionId(), socket:socket,status:"joining",syncStatus:"idle", nmcPointer:new Date(), statusTime:new Date(), isAlive:true, nmdId:nmdId, mode:"sink", fromTime:query.fromTime};
        logInfo("created new sink nmConnection[" + nmConnection.id + "] for nmd " + nmdId);
        nmConnections.push(nmConnection);
        flushNMC(nmConnection);
      }

      wsServer.emit('connection', socket, request);
    });
    return;

  }
  logInfo("mismatching request url " + request.url);
  socket.destroy();
});


function log(nmdId, message, nmdLog=true){
  let nmd = nmdsList[nmdId];
  let d = new Date();
  let timestamp = d.getFullYear()+"-"+(d.getMonth()+1)+"-"+d.getDate()+" "+d.getHours()+":"+d.getMinutes()+":"+d.getSeconds();
  let timestampShort = d.getHours()+":"+d.getMinutes()+":"+d.getSeconds();
  let logEntry = {timestamp:d.getTime(), timestr:timestampShort, message:message, activePlayerId:nmd.activePlayer};
  if(nmdLog && nmd.log && nmd.log[0]) {
    if(nmdLog)nmd.log[0].entries.unshift(logEntry);
  }
  logInfo(timestamp+"-" + nmdId+": " +message);
}

app.get('/', (req, res) => {
  res.send('gr4per/nms v' + pjson.version)
})

/**
server api
----------

GET /api/nmds/list
POST /api/nmds/<id>/join - initiate websocket link
POST /api/nmds/<id>/events - add new state modification

Later:
PUT /api/nmds/<id> - create new nmd
*/

// each nmd has local state in this structure nmd -> {blobServiceClient:, containerClient:,currentFileName:, currentBuffer:}
let nmdsList = { };
initNmds();

async function listFiles(path) {
  let fileNames = [];
  if(containerClient) {
    let i = 1;
    let blobs = containerClient.listBlobsFlat();
    for await (const blob of blobs) {
      //logInfo(`Blob ${i++}: ${blob.name}`);
      fileNames.push(blob.name.substring(path.length,blob.name.length));
    }
  }
  else {
    let dirents = fs.readdirSync(path,{withFileTypes:true});
    for(let de of dirents) {
      if(de.isFile()) {
        fileNames.push(de.name);
      }
    }
    fileNames = fileNames.filter(e => {return e.indexOf("_")>-1 && e.endsWith("Z.json")});
  }
  return fileNames;
}

async function initNmds() {
  let nmds = Object.keys(nmCreds);
  logInfo("found nmds: " + JSON.stringify(nmds));
  let coveredNmdIds = [];
  for(let nmd of nmds) {
    try {
      nmdsList[nmd] = {};
      await initNmd(nmd);
      logInfo("Successfully initialized nmd " + nmd);
    }
    catch(e) {
      delete nmdsList[nmd];
      logError("Error initializing nmd " + nmd + ": ", e);
    }
  }
  logInfo("all loading done");
}

// [Node.js only] A helper method used to read a Node.js readable stream into a Buffer
async function streamToBuffer(readableStream) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    readableStream.on("data", (data) => {
      chunks.push(data instanceof Buffer ? data : Buffer.from(data));
    });
    readableStream.on("end", () => {
      resolve(Buffer.concat(chunks));
    });
    readableStream.on("error", reject);
  });
}
  
async function readFile(nmd, path) { // returns a buffer
  let data = null;
  if(nmdsList[nmd].containerClient) {
    let blobClient = null;
    let downloadBlockBlobResponse = null;
    try {
      blobClient = nmdsList[nmd].containerClient.getBlobClient(path);
      downloadBlockBlobResponse = await blobClient.download();
      data = await streamToBuffer(downloadBlockBlobResponse.readableStreamBody);
      //logInfo("Downloaded blob content:", data);
    }
    catch(e) {
      logError("blob " + path + " not found in nmd " + nmd);
      throw e;
    }
  }
  else {
    data = fs.readFileSync(path);
  }
  return data;
}

async function writeFile(containerClient, path, content) {
  if(containerClient) {
    let blockBlobClient = containerClient.getBlockBlobClient(path);
    let uploadBlobResponse = await blockBlobClient.upload(content, content.length);
    logInfo("Upload block blob " + path + " successful", uploadBlobResponse.requestId);  
  }
  else {
    fs.writeFileSync(path, content);
  }
}


async function flushNmdBuffer(nmd) {
  let flushInfo = pendingFlushes[nmd.nmdId];
  flushInfo[nmd.currentFileName] = nmd.currentBuffer;
  logInfo("flushInfo on nmd " + nmd.nmdId + ": " + JSON.stringify(Object.keys(flushInfo)));
  if(flushInfo.flushing) { // prevent multiple entry
    logInfo("nmdBuffer " + nmd.nmdId + " currently flushing, adding current buffer " + nmd.currentFileName + " to pending list...");
    return;
  }
  flushInfo.flushing = true;
  let filesToFlush = Object.keys(flushInfo);
  logInfo("filesToFlush on nmd " + nmd.nmdId + ": " + JSON.stringify(filesToFlush));
  for(let ffn of filesToFlush) {
    if(ffn == "flushing")continue;
    let data = flushInfo[ffn];
    if(data) {
      logInfo("trying to flush " + data.length + " bytes to " + ffn + "...");
      try {
        await writeFile(nmd.containerClient, ffn, data);
        logInfo("successfully flushed " + ffn);
        if(flushInfo[ffn] && flushInfo[ffn].length == data.length) {
          // all data flushed
          delete flushInfo[ffn];
          logInfo("all data flushed to " + ffn + ", removing from pending list.");
        }
      }
      catch(e) {
        logError("error flushing nmd buffer " + nmd.nmdId + " to file " + fn);
      }
    }
    else {
      logInfo("flush buffer of " + ffn + " is empty, removing.");
      delete flushInfo[ffn];
    }
  }
  flushInfo.flushing = false;
}

async function flushBuffers() {
  return Promise.all(Object.values(nmdsList).map( (nmd) => {
    return flushNmdBuffer(nmd);
  }));
}

function zeroPad(str,digits) {
  str = ""+str;
  while(str.length < digits) {
    str = "0"+str;
  }
  return str;
}

function getFileName(time) {
  return time.toISOString().substring(0,4)+"/"+zeroPad(time.getUTCMonth()+1,2)+"/"+zeroPad(time.getUTCDate(),2)+"/"+zeroPad(time.getUTCHours(),2)+".csv";
}

let bands = ["A","B","C","Z","6.3Hz","8Hz","10Hz","12.5Hz","16Hz","20Hz","25Hz","31.5Hz","40Hz","50Hz","63Hz","80Hz","100Hz","125Hz","160Hz","200Hz","250Hz","315Hz","400Hz","500Hz","630Hz","800Hz","1kHz","1.25kHz","1.6kHz","2kHz","2.5kHz","3.15kHz","4kHz","5kHz","6.3kHz","8kHz","10kHz","12.5kHz","16kHz","20kHz"];
let header = "IntervalEnd\tRespTime\t";
for(let i = 0; i < bands.length;i++) {
  header += "Leq"+bands[i]+"\t";
}
for(let i = 0; i < bands.length;i++) {
  header += "Leq"+bands[i]+"_a300\t";
}
for(let i = 0; i < bands.length;i++) {
  header += "Leq"+bands[i]+"_a3600\t";
}
for(let i = 0; i < bands.length;i++) {
  header += "Leq"+bands[i]+"_attn\t";
}
function getCSVHeader() {
  return header;
}

/* init storage account / container client for nmd
 * load existing files from storage account into current buffer
 */
async function initNmd(nmd) {
  let storageAccountUrl = nmCreds[nmd].saConnStr;
  let blobServiceClient = null;
  let containerClient = null;
  nmdsList[nmd].nmdId = nmd;
  pendingFlushes[nmd] = {flushing:false};
  if(storageAccountUrl) {
    blobServiceClient = BlobServiceClient.fromConnectionString(storageAccountUrl);
    logInfo("opened blob service client on nmd " + nmd);
    if(blobServiceClient) {
      nmdsList[nmd].blobServiceClient = blobServiceClient;
      containerClient = blobServiceClient.getContainerClient(nmd);
      if(containerClient) {
        logInfo("opened container client for container " + nmd);
        nmdsList[nmd].containerClient = containerClient;

        // find latest existing file
        let currentSearchDate = new Date();
        let fn = getFileName(currentSearchDate);
        let buffer = null;
        while(buffer == null && currentSearchDate.getTime() > new Date().getTime()-3600*24*1000) { // max one day
          // load existing blob file to prime internal buffer
          try {
            buffer = await readFile(nmd, fn);
            logInfo("found existing file " + fn);
          }
          catch(e) {
            logInfo("file " + fn + " not found");
            currentSearchDate = new Date(currentSearchDate.getTime()-3600*1000); // go one hour earlier
            fn = getFileName(currentSearchDate);
          }
        }
        
        nmdsList[nmd].currentFileName = fn;
        if(buffer) {
          nmdsList[nmd].currentBuffer = buffer.toString();
          logInfo("Successfully ingested existing buffer file " + fn + " for nmd " + nmd);
        }
        else {
          logError("No buffer file nmd " + nmd + " found for the last 24hrs. Starting blank.");
          logInfo("Creating new Buffer for nmd " + nmd);
          nmdsList[nmd].currentBuffer = getCSVHeader();
          nmdsList[nmd].lastFlush = new Date();
        }
      }
      else {
        logError("Failed to create container client for container " + nmd);
      }
      //{blobServiceClient:, containerClient:,currentFileName:, currentBuffer:}
    }
  }
  else {
    let e = new Error("NMD has no storage Account URL configured: " + nmd);
    logError(e);
  }
}

app.get('/api/nmds/:nmdId/join', (req, res) => {
  let nmdId = req.params.nmdId;
  let nmId = req.params.nmId;
  //logInfo("checking request: " + req.url);
  res.header('Access-Control-Allow-Origin', '*');
  let token = req.query.token;
  let mode = req.query.mode;
  if(nmCreds[nmId].nmcSASUrls.indexOf(token) > -1) {
    logInfo("Join request to " + nmId + " with valid SAS token.");
    if(mode != "sink") {
      logInfo("request with NMC token but conflicting mode " + mode + ": " + req.url);
      res.status(404).send('not found');
      return;
    }
  }
  else if(nmCreds[nmId].nmdToken == token) {
    logInfo("Join request to " + nmId + " with valid NMPI api token.");
    if(mode != "source") {
      logInfo("request with source API token but conflicting mode " + mode + ": " + req.url);
      res.status(404).send('not found');
      return;
    }
  }
  else {
    logInfo("request without valid api token: " + req.url + ", apiToken: " + token);
    res.status(404).send('not found');
    return;
  }
  logInfo("got request from nm " + nmId + " to join nmd " + nmdId);
});


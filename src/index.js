const pjson = require('../package.json');
const express = require('express');
const url = require('url');
const querystring = require('querystring');
const fs = require('fs');
const {Dsp206} = require("./../dsp206.js")

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
      tags: ["Winston-NodeJS dsp206proxy"],
      json: true
  }));

  console.log("dsp206Proxy connected to loggly!");
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

process.on('SIGINT', exitGracefully);

process.on('SIGTERM', exitGracefully);

async function exitGracefully(signal) {
  logInfo("received signal " + signal + ".");
  process.exit(0);
}

const server = app.listen(serverPort);

app.get('/', (req, res) => {
  res.send('gr4per/nms v' + pjson.version)
})

/**
server api
----------

*/

function zeroPad(str,digits) {
  str = ""+str;
  while(str.length < digits) {
    str = "0"+str;
  }
  return str;
}

function formatHexDump(bytes) {
  let resString = "";
  let ascii = "";
  for(let i = 0; i < bytes.length;i++) {
    if(i%16 == 0) resString += zeroPad(i.toString(16),4) + " ";
    resString += ""+zeroPad(bytes[i].toString(16),2)+" ";
    ascii += (bytes[i] < 0x20)?".":((bytes[i]>0x7e)?".":String.fromCodePoint(bytes[i]));
    if((i+1)%16 == 0 || i == bytes.length -1 ) {
      resString += "\t"+ascii+"\n";
      ascii = "";
    } 
  }
  return resString;
}

let bands = ["A","B","C","Z","6.3Hz","8Hz","10Hz","12.5Hz","16Hz","20Hz","25Hz","31.5Hz","40Hz","50Hz","63Hz","80Hz","100Hz","125Hz","160Hz","200Hz","250Hz","315Hz","400Hz","500Hz","630Hz","800Hz","1kHz","1.25kHz","1.6kHz","2kHz","2.5kHz","3.15kHz","4kHz","5kHz","6.3kHz","8kHz","10kHz","12.5kHz","16kHz","20kHz"];
const geqFrequencies = [20,25,31.5,40,50,63,80,100,125,160,200,250,315,400,500,630,800,1000,1250,1600,2000,2500,3150,4000,5000,6300,8000,10000,12500,16000,20000];

let inChannels = ['InA', 'InB'];
let deviceId = 250;
let ipAddress = "192.168.188.22";

let dsp206 = new Dsp206(deviceId, ipAddress, {rerun:"false"});



app.get('/api/dump', async (req, res) => {
  let channelId = req.params.channelId;
  let bandId = req.params.bandId;
  let level = req.body.level;
  logInfo("checking request: " + req.url + ", body = " + JSON.stringify(req.body));

  res.header('Access-Control-Allow-Origin', '*');
  if(dsp206.clientStatus < 4) {
    console.log("dsp206 not ready to read geq level, connection status " + dsp206.clientStatus + ", sending 502.");
    res.status(502).send({
      message: 'Sound hardware not reachable.'
    });
  }
  let memDump = [];
  
  for(let i = 0;i < 13;i++) {
    console.log("dumping page " + i);
    let res = await dsp206.sendCommand(0x27, [i]);
    res = res.slice(1,res.length);
    //let res = await dsp206.dumpMemory(0x27+i*0x37,0x37);
    console.log("Config page has " + (res.length) + " bytes");
    memDump = memDump.concat(res);
  }
  logInfo("got request to set geq " + channelId + " band " + bandId + " to level " + level);
  
  res.status(200).setHeader("Content-Type", "text/plain").send(formatHexDump(memDump));
});

function validateInChannel(channelId, res) {
  let numChannelId = parseInt(channelId);
  if(numChannelId > -1 && numChannelId < 2) return numChannelId;
  let channelIdx = inChannels.indexOf(channelId);
  if(channelIdx < 0) {
    res.status(400).send({message:"" + channelId + " is not a valid inchannel, must be one of " + inChannels});
  }
  return channelIdx;
}

function validateGeqBand(bandId, res) {
  let nf = parseFloat(bandId.replace(/k/g,"000").replace(/Hz/g,"").replace(/Leq/g,""));
  let bandIdx = geqFrequencies.indexOf(nf);
  if(bandIdx < 0) {
    res.status(400).send({message:"" + bandId + " is not a valid geq channel, must match one of the frequencies " + geqFrequencies + ", or alternative spelling such as 2.5kHz, 250Hz etc."});
  }
  return nf;
}

app.get('/api/inchannel/:channelId/geq', async (req, res) => {
  let channelId = req.params.channelId;
  logInfo("checking request: " + req.url + ", body = " + JSON.stringify(req.body));

  let channelIdx = validateInChannel(channelId, res);
  if(channelIdx < 0) return;

  res.header('Access-Control-Allow-Origin', '*');
  if(dsp206.clientStatus < 4) {
    console.log("dsp206 not ready to read geq level, connection status " + dsp206.clientStatus + ", sending 502.");
    res.status(502).send({
      message: 'Sound hardware not reachable.'
    });
  }
  let icc = null;
  try {
    icc = await getInChannelConfig(channelIdx);
  }
  catch(e) {
    console.error("could not get geq config: ", e);
    res.status(500).send({message:""+e});
    return;
  }
  res.status(200).send(icc.geqConfig);
});

async function getInChannelConfig(channelIdx) {
  let configOffset = 0x10+0x8c*channelIdx;
  let configPage = Math.floor(configOffset/50);
  let configPageOffset = configOffset-50*configPage;
  let endOffset = configOffset+0x8c;
  let endPage = Math.floor(endOffset/50);
  let endPageOffset = endOffset-50*endPage;
  console.log("config for inchannel " + channelIdx + " is at offset 0x" + configOffset.toString(16) + ", starting on page " + configPage + " with pageOffset 0x" +  configPageOffset.toString(16) + " and extending up to page " + endPage + " with offset 0x" + endPageOffset.toString(16));
  let result = [];
  for(;configPage <endPage+1;configPage++) {
    let page = null;
    try {
      page = await dsp206.sendCommand(0x27,[configPage]);
    }
    catch(e) {
      console.error("error from dsp206 bubbled up ", e);
      throw e;
    }
    result = result.concat(page.slice(1,page.length));
  }
    
  result = result.slice(configPageOffset, configPageOffset+0x8c);
  return dsp206.parseInChannelConfig(result, 0x0);
}

app.get('/api/inchannel/:channelId/geq/:bandId/level', async (req, res) => {
  let channelId = req.params.channelId;
  let bandId = req.params.bandId;
  let level = req.body.level;
  logInfo("checking request: " + req.url + ", body = " + JSON.stringify(req.body));

  let channelIdx = validateInChannel(channelId, res);
  if(channelIdx < 0) return;

  let bandIdx = validateGeqBand(bandId, res);
  if(bandIdx < 0) return;

  res.header('Access-Control-Allow-Origin', '*');
  if(dsp206.clientStatus < 4) {
    console.log("dsp206 not ready to read geq level, connection status " + dsp206.clientStatus + ", sending 502.");
    res.status(502).send({
      message: 'Sound hardware not reachable.'
    });
  }
  let icc = await getInChannelConfig(channelIdx);
  res.status(200).send(icc.geqConfig.find(e=>{return e.bandId == bandIdx;}));
});

app.post('/api/inchannel/:channelId/geq/:bandId', async (req, res) => {
  let channelId = req.params.channelId;
  let bandId = req.params.bandId;
  let level = req.body.level;
  logInfo("checking request: " + req.url + ", body = " + JSON.stringify(req.body));
  let channelIdx = validateInChannel(channelId, res);
  if(channelIdx < 0) return;

  let frequency = validateGeqBand(bandId, res);
  if(frequency < 0) return;
  
  console.log("channelIdx = " + channelIdx + ", frequency = " + frequency + ", level = " + level);
  res.header('Access-Control-Allow-Origin', '*');
  if(dsp206.clientStatus < 4) {
    console.log("dsp206 not ready to take geq level, connection status " + dsp206.clientStatus + ", sending 502.");
    res.status(502).send({
      message: 'Sound hardware not reachable.'
    });
  }
  let result = null;
  try {
    result = await dsp206.setGeqLevel(channelIdx, frequency, level);
    logInfo("set geq in channel " + channelId + ", band " + bandId + " to level " + level);
    res.status(200).send({message:"Setting applied."});
    }
  catch(e) {
    if(e.message.startsWith("Invalid GEQ frequency")) {
      res.status(400).send({message:e.message});
      return;
    }
    res.status(500).send({message:""+e});
    return;
  }
});


const net = require('net');

function sleep(millis) {
  return new Promise(resolve => setTimeout(resolve, millis));
}

const logfn = console.log
console.log = function(){
  let args = Array.from(arguments);
  let datePf = "" + new Date().toISOString() + ": ";
  if(typeof args[0] == "string") {
    args[0] = datePf + args[0];
  }
  else {
    args.unshift("" + new Date().toISOString() + ": ");
  }
  logfn(...args);
}

const responseCodeByCommandCode = {"10":0x10,"13":0x13,"14":0x14,"19":0x19,"22":0x22,"27":0x24,"28":0x28,"29":0x29,"2c":0x2c,"2d":0x2d,"40":0x40};
const projectableCommands = {"10":0,"11":0,"12":0,"13":0,"14":0,"15":0,"19":0,"20":0,"22":0,"26":0,"2d":0,"2f":0,"30":1,"31":1,"32":1,"33":2,"34":1,"35":1,"36":1,"38":1,"39":0,"3a":1,"3b":1,"3c":1,"3d":1,"3e":1,"3f":1,"40":0,"41":2,"48":2,"49":1};
const slopeTypes = ["bypass", "BW-6","BL-6","BW-12","BL-12","LK-12","BW-18","BL-18","BW-24","BL-24","LK-24","BW-30","BL-30","BW-36","BL-36","LK-36","BW-42","BL-42","BW-48","BL-48","LK-48"];
const geqBands = [20,25,31.5,40,50,63,80,100,125,160,200,250,315,400,500,630,800,1000,1250,1600,2000,2500,3150,4000,5000,6300,8000,10000,12500,16000,20000];
const compressorRatios = ["1:1","1:1.1","1:1.3","1:1.5","1:1.7","1:2","1:2.5","1:3","1:3.5","1:4","1:5","1:6","1:8","1:10","1:20","flat"];
const peqTypes = ["Peak","LowShelf","HighShelf","LP-6dB","LP-12dB","HP-6dB","HP-12dB","Allpass1","Allpass2"];
const maxIdleMillis = 5000;
const maxClosingDelay = 1000;

class Dsp206 {

  constructor(deviceID, ipAddress, options) {
    this.deviceID = deviceID;
    this.ipAddress = ipAddress;
    this.pendingResponses = {}; // a fifo array per response code
    this.lastResponse = null;
    this.clientStatus = 0; // 0 = no socket(socket == null), 1 = socket ending, 2 = socket destroyed (socket.destroyed), 3 = socket connecting (socket.pending), 4 = resending, 5 = connected
    this.client = null;
    this.initConnection();
  }
  
  checkConnection() {
    // is the connection alive?
    let deltaMillis = new Date().getTime() - this.lastResponse.getTime();
    if(deltaMillis > maxIdleMillis) {
      if(this.clientStatus == 3) {
        // we have been waiting for connection 
        console.log("checkConnection: timeout while trying to connect " + deltaMillis + " ms. Re-trying.");
        this.client.destroy();
        this.clientStatus = 2;
      }
      else if(this.clientStatus >= 4) {
        console.log("check connection: no response for " + deltaMillis + " ms. ending it.");
        this.client.end( (err) => {
          console.log("socket end completed");
          this.client.destroy();
          this.clientStatus = 2;
        }); // send FIN packet
        this.clientStatus = 1;
      }
      else if(this.clientStatus == 1 && deltaMillis > maxIdleMillis+maxClosingDelay) {
        this.client.destroy();
        this.clientStatus = 2;
      }
    }
    else if(this.clientStatus == 5 && new Date().getTime()-this.lastResponse.getTime() > 2000) {
      console.log("sending ping");
      this.sendCommand(0x12,[]); // send a ping to keep dsp happy
    }
    if(this.clientStatus == 0 || this.clientStatus == 2) {
      this.clientStatus == 0;
      this.initConnection();
    }
  }
  
  initConnection() {
    if(this.clientStatus != 0 && this.clientStatus != 2) {
      console.log("initConnection: clientStatus is " + this.clientStatus + ", skipping re-entry.");
      return;
    }
    this.clientStatus = 3;
    this.lastResponse = new Date(); // give us some time before the check starts acting
    this.interval = setInterval(this.checkConnection.bind(this),2000); // regular sanity check on the connection
    
    // options port, host, localAddress, localPort, family, hints, lookup, noDelay, keepAlive, keepAliveInitialDelay, timeout
    this.client = net.createConnection({ host:this.ipAddress, port: 9761 }, async () => {
      // 'connect' listener.
      console.log('connected to server!');
      this.clientStatus = 4;
      // now we have to make sure pending commands are flushed to server
      await this.rerunPendingCommands();
      this.clientStatus = 5;
    });
    this.client.on('data', (data) => {
      this.lastResponse = new Date();
      if(this.clientStatus == 4) {
        console.log("received response while client in status " + this.clientStatus + ", so this is re-run after connect.");
      }
      else if(this.clientStatus != 5) {
        console.log("received response while client in status " + this.clientStatus + ", ignoring.");
        return;
      }
      //console.log("received data: ", data);
      if(data[0] != 0x10 || data[1] != 0x2) {
        console.error("incorrect response header!");  
        return;
      }
      if(data[3] != 0x0) {
        console.error("incorrect destination ID " + data[3]);  
        return;
      }
      if(data[2] != this.deviceID) {
        console.error("incorrect source ID " + data[2] + ", should be " + deviceID);  
        return;
      }
      let dataLen = data[4];
      //console.log("body length = " + dataLen);
      let payload = new Array(dataLen-1);
      let rcode = data[5];
      //console.log("response code = 0x" + rcode.toString(16));
      let resp = this.findPendingResponse(rcode);
      if(!resp) {
        console.error("did not find pendingResponse by rcode 0x" + rcode.toString(16) + ", data = " + JSON.stringify(data) );
        return;
      }
      for(let i = 0; i < payload.length;i++) {
        payload[i] = data[6+i];
      }
      if(data[5+dataLen] != 0x10 || data[6+dataLen] != 0x3) {
        let msg = "incorrect eom marker " + data[5+dataLen] + " " + data[6+dataLen] + ", should be 0x10 0x3" + ", data type = " + typeof data + ", JSON=" + JSON.stringify(data);  
        resp.reject(new Error(msg));
        return;
      }
      let checksum = data[7+dataLen];
      if(typeof checksum == 'undefined') {
        let msg = "response doesn't have a checksum. dataLen = " + dataLen + ", data = " + JSON.stringify(data);
        console.log(msg);
        resp.reject(new Error(msg));
        return;
      }
      let lcs = 0;
      for(let i = 0; i < data.length-1;i++) {
        lcs ^= data[i];
      }
      if(lcs != checksum) {
        let msg = "checksum from response " + checksum.toString(16) + " not matching calculated one " + lcs.toString(16) + ", data = " + JSON.stringify(data);
        resp.reject(new Error(msg));
      }
      console.log("response with code " + rcode.toString(16) + (payload.length>0?" has payload=" + payload + "[" + String.fromCodePoint(...payload)+ "]" : " without payload"));
      resp.resolve(this.parsePayload(rcode, payload));
    });

    this.client.on('error', (err) => {
      console.log('socket error: ', e);
      this.clientStatus = 1;
      this.client.end((err) => {
          console.log("socket end completed");
          this.client.destroy();
          this.clientStatus = 2;
      }); // send FIN packet);
    });
    
    this.client.on('end', () => {
      console.log('disconnected from server');
      this.clientStatus = 2;
    });
  }
  
  async close() {
    return new Promise((resolve, reject) => {
      clearInterval(this.interval);
      this.clientStatus = 1;
      this.client.end((err) => {
        console.log("socket end completed");
        this.client.destroy();
        this.clientStatus = 2;
        resolve();
      }); // send FIN packet);
    });
  }
  
  parseString(bytes, start, end = null) {
    //console.log("parseString " + bytes + ", " + start + ", " + end);
    let ni = bytes.indexOf(0,start);
    if(end == null) {
      if(ni == -1) {
        throw new Error("no null termination of string in bytes " + JSON.stringify(bytes) + " starting at pos " + start);
      }
      end = ni;
    }
    else {
      if(ni > -1 && ni< end) end = ni;  
    }
    let res = String.fromCodePoint(...(bytes.slice(start,end)));
    return res;
  }
  
  parseDword(bytes,start) {
    return bytes[start]+bytes[start+1]<<8+bytes[start+2]<<16+bytes[start+3]<<24;
  }
  
  parseWord(bytes,start) {
    return bytes[start]+(bytes[start+1]<<8);
  }
  
  writeWord(bytes, start, value) {
    bytes[start]= value&0xff;
    bytes[start+1]= (value&0xff00)>>8;
  }
  
  /**
   * Take the Uint8Array 
   */
  parsePayload(rcode, payload) {
    switch(rcode) {
      case 0x1:
        return true; // no payload
      case 0x2:
        return false;
      case 0x10:
        return payload[0]; // single int value
      case 0x13:
        return this.parseString(payload, 0, payload.length);
      case 0x14:
        return playload[0]; // single int value
      case 0x19:
        return payload;
      case 0x24:
        return payload; //(this is a byte array only, partial mem dump)
      case 0x28:
        return payload; //(this is a byte array only, partial mem dump)
      case 0x29:
        return {presetID:payload[0], presetName:this.parseString(payload,1,payload.length)};
      case 0x2c:
        return payload; // no idea what this is
      case 0x2d:
        return payload[1] == 0?false:true;
      default:
        return payload.map(el=>{return el.toString(16);});
    }
  }
  
  /**
   * Sets the measurement unit for delay
   * unit - string "ms", "m" or "ft"
   */
  async setUnit(unit) {
    let unitCode = null;
    switch(unit) {
      case "ms":
        unitCode=0;
        break;
      case "m":
        unitCode=1;
        break;
      case "ft":
        unitCode=2;
        break;
      default:
        throw new Error("Unit code " + unit + " not recognized, allowed codes are ['ms','m','ft']");
    }
    return this.sendCommand(0x15,[unitCode]);
  }
  
  unitToString(unit) {
    return unit==0?"ms":unit==1?"m":unit==2?"ft":"unknown";
  }
  
  /**
   * Return an extract of len bytes from the device mem, starting at offset
   * offset - integer
   * len - integer (capped at 0x37)
   * Note: offset+len must be in the range 0x0-0x764
   * return byte array 
   */
  async dumpMemory(offset, len) {
    if(len > 0x37 || len < 0) {
      throw new Error("len must be positive and less than " + 0x38 + " bytes!");
    }
    if(offset+len > 0x764 || offset < 0) {
      throw new Error("offset must be positive and offset + len must be in the range 0x0 -0x764!");
    }
    return this.sendCommand(0x19,[offset&0xff,(offset&0xff00)>>8,len]);
  }
  
  /**
   * Loads a preset.
   * presetID - integer 0  = F00 Factory Default
   *                    1  = U01 User Preset
   *                    ...
   *                    20 = U20 User Preset
   */
  async loadPreset(presetID) {
    if(presetID <0 || presetID > 20) {
      throw new Error("presetID must be in the range 0-20!");
    }
    return this.sendCommand(0x20,[presetID]);
  }
  
  /**
   * Stores current settings to a preset.
   * presetID - integer 0  = F00 Factory Default
   *                    1  = U01 User Preset
   *                    ...
   *                    20 = U20 User Preset
   */
  async storePreset(presetID) {
    if(presetID <0 || presetID > 20) {
      throw new Error("presetID must be in the range 0-20!");
    }
    return this.sendCommand(0x21,[presetID]);
  }
  
  /**
   * Get info about which preset slots are used.
   * Return array(21) with boolean true - user defined preset, false - default preset
   */
  async getPresetInfo() {
    let presetInfo = await this.sendCommand(0x22,[]);
    let res = new Array(21);
    res[0] = false; // factory preset
    for(let i = 0; i< res.length;i++) {
      res[i+1] = presetInfo[i]>0;
    }
    return res;
  }
  
  /**
   * Sets the export pointer to the respective slot
   * without affecting currently active settings.
   * presetID - integer 0-20, see loadPreset
   */
  async setExportPreset(presetID) {
    return this.sendCommand(0x24,[presetID]);
  }
  
  async getCurrentConfig() {
    let res = await this.getConfig(null);
  }
  
  async getConfig(presetID) {
    let res = [];
    let ccode = presetID == null?0x27:0x28;
    if(ccode == 0x28) {
      await this.setExportPreset(presetID);
    }
    for(let p = 0; p < 19; p++) {
      let bytes = await this.sendCommand(ccode, [p]);
      //console.log("bytes = " + typeof bytes + ", " + bytes);
      res = res.concat(bytes.slice(1,bytes.length)); // first byte is page ID, then data bytes
    }
    
    // now read the different config elements
    let s = {word0x0:this.parseWord(res,0), presetName:this.parseString(res,2,16),inChannelConfigs:[], outChannelConfigs:[]};
    console.log("parsed current preset name = " + s.presetName);
    for(let i = 0; i < 2; i++) {
      console.log("parsing in channel config " + i + ", starting at offset " + (16+i*0x8c));
      s.inChannelConfigs.push(this.parseInChannelConfig(res, 16+i*0x8c));
      console.log("parsed: " + JSON.stringify(s.inChannelConfigs[s.inChannelConfigs.length-1],null,2));
    }
    for(let i = 0; i < 6; i++) {
      s.outChannelConfigs.push(this.parseOutChannelConfig(res, 16+2*0x8c+i*0x64));
      console.log("parsed: " + JSON.stringify(s.outChannelConfigs[s.outChannelConfigs.length-1],null,2));
    }
    let offset = 16+2*0x8c+6*0x64;
    s.muteIn = this.parseWord(res,offset);
    s.muteOut = this.parseWord(res,offset+2);
    offset+=16; // 8 word we don't understand yet
    s.testTone = this.parseWord(res,offset);
    s.testTone = s.testTone==0?"off":s.testTone==1?"pink noise":s.testTone==2?"white noise":"sine wave";
    s.testToneFrequency = this.wordToFreq1_3(this.parseWord(res,offset+2));
    s.delayUnit = this.parseWord(res,offset+4);
    s.delayUnit = this.unitToString(s.delayUnit);
    return s;
  }
  
  async setPresetName(presetID, name) {
    if(name.length>14) {
      name = name.substring(0,14);
    }
    
    let bytes = new Array(15);
    bytes[0] = presetID;
    this.writeStringToByteArray(bytes, 1, name);
    return this.sendCommand(0x26,bytes);
  }
  
  async getPresetName(presetID) {
    return this.sendCommand(0x29,[presetID]);
  }    
  
  async copyChannel(sourceChannelID, targetChannelID) {
    return this.sendCommand(0x2a,[sourceChannelID, targetChannelID]);
  }
  
  async unlock(password) {
    let bytes = new Array(5);
    this.writeStringToByteArray(bytes,1,password);
    return this.sendCommand(0x2d,bytes);
  }
  
  async lock(password) {
    let bytes = new Array(4);
    this.writeStringToByteArray(bytes,0,password);
    return this.sendCommand(0x2f,bytes);
  }
  
  
  writeStringToByteArray(bytes, offset, str){
    for (var i = 0; i < str.length; ++i) {
      var charCode = str.charCodeAt(i);
      if (charCode > 0xFF) {
        throw new Error('Character ' + String.fromCharCode(charCode) + ' can\'t be represented by a US-ASCII byte.');
      }
      bytes[offset+i] = charCode;
    }
  }  
  
  parseOutChannelConfig(bytes, offset) {
/*
  OutChannel config (len = 0x62)
  0x00 - 8 byte channel name (zero padded)
  0x08 - 1 word routing (0 = none, 1=InA, 2=InB, 3=both, see ccode 0x3a)
  0x0a - 1 word InA MixerGain (see ccode 0x41)
  0x0c - 1 word InB MixerGain (see ccode 0x41)
  0x0e - 1 word HP frequency (see ccode 0x32)
  0x10 - 1 word LP frequency (see ccode 0x31)
  0x12 - 1 byte HP Slope (see ccode 0x32)
  0x13 - 1 byte LP Slope (see ccode 0x31)
  0x14 - 9*6byte PEQ settings (0-8), each: word gain, word frequency, byte Q, byte type (see ccode 0x33)
  0x4a - word compressor ratio (see ccode 0x30)
  0x4c - word compressor attack
  0x4e - word compressor release
  0x50 - word compressor knee
  0x52 - word compressor threshold
  0x54 - word Limit attack (see ccode 0x3f)
  0x56 - word Limit release (see ccode 0x3f)
  0x58 - word Limit reserved (see ccode 0x3f)
  0x5a - word Limit threshold (see ccode 0x3f)
  0x5c - word gain
  0x5e - word phase (see ccode 0x36)
  0x60 - word delay (see ccode 0x38)
  0x62 - word routing bitmask (Out1=1,Out2=2,Out3=4,Out4=8,Out5=10,Out6=20)
*/
    let res = {};
    res.channelName = this.parseString(bytes, offset+0, offset+8);
    res.routing = this.parseWord(bytes,offset+8);
    res.gainInA = this.convertToDb4(this.parseWord(bytes, offset+0xa));
    res.gainInB = this.convertToDb4(this.parseWord(bytes, offset+0xc));
    res.highPassFrequency = this.convertToFrequency(this.parseWord(bytes, offset+0xe));
    res.lowPassFrequency = this.convertToFrequency(this.parseWord(bytes, offset+0x10));
    res.highPassSlope = bytes[offset+0x12];
    res.lowPassSlope = bytes[offset+0x13];
    res.peqConfig = this.parsePeqConfig(bytes, offset+0x14,9);    
    res.compressorConfig = this.parseCompressorConfig(bytes, offset+0x4a);
    res.limiterConfig = this.parseLimiterConfig(bytes, offset+0x54);
    res.gain = this.convertToDb3(this.parseWord(bytes, offset+0x5c));
    res.phase = bytes[offset+0x5e]==1?"inverted":"normal";
    res.delay = this.convertToMs3(this.parseWord(bytes, offset+0x60));
    res.routingMask = this.parseWord(bytes, offset+0x62);
    return res;
  }

  parseInChannelConfig(bytes, offset) {
/*
      0x00 - 8 byte channel name
      0x08 - 4 word gate config
      0x10 - 31 word GEQ config
      0x4e - 8*6byte PEQ settings (0-7), each: word gain, word frequency, byte Q, byte type (see ccode 0x33)
      0x7e - 1 word HP frequency (see ccode 0x32)
      0x80 - 1 word LP frequency (see ccode 0x31)
      0x82 - 1 byte HP Slope (see ccode 0x32)
      0x83 - 1 byte LP Slope (see ccode 0x31)
      0x84 - word gain
      0x86 - word phase
      0x88 - word delay
      0x8a - word routing bitmask (InA=1, InB=2)
*/
    let res = {};
    res.channelName = this.parseString(bytes, offset+0, offset+8);
    console.log("parsed in channel name " + res.channelName + ", bytes = " + bytes.map(el=>{return el.toString(16);}).join(" "));
    res.gateConfig = this.parseGateConfig(bytes,offset+8);
    console.log("parsed gate config: " + JSON.stringify(res.gateConfig));
    res.geqConfig = this.parseGeqConfig(bytes,offset+0x10);
    console.log("parsed geq config: " + JSON.stringify(res.geqConfig));
    res.peqConfig = this.parsePeqConfig(bytes, offset+0x4e,8);
    console.log("parsed peq config: " + JSON.stringify(res.peqConfig));
    console.log("parsing shelve config from " + bytes.slice(offset+0x7e,offset+0x7e+6).map(el=>{return el.toString(16);}).join(" "));
    res.highPassFrequency = this.convertToFrequency(this.parseWord(bytes, offset+0x7e));
    res.lowPassFrequency = this.convertToFrequency(this.parseWord(bytes, offset+0x80));
    res.highPassSlope = bytes[offset+0x82];
    res.lowPassSlope = bytes[offset+0x83];
    console.log("parsed shelving config: " + JSON.stringify({hpFreq:res.highPassFrequency, lpFreq:res.lowPassFrequency, hpSlope:res.highPassSlope, lpSlope:res.lowPassSlope}));
    res.gain = this.convertToDb3(this.parseWord(bytes, offset+0x84));
    res.phase = bytes[offset+0x86]==1?"inverted":"normal";
    res.delay = this.convertToMs3(this.parseWord(bytes, offset+0x88));
    res.routingMask = this.parseWord(bytes, offset+0x8a);
    return res;
  }
  
  byteToSlopeType(value) {
    if(value < 0 || value > slopeTypes.length-1) {
      throw new Error("value without range 0.." + (slopeTypes.length-1) + ": " + value);
    }
    return slopeTypes[value]; //byte type (0=Peak,1=LowShelf,2=HighShelf,3=LP-6dB,4=LP-12dB,5=HP-6dB,6=HP-12dB,7=Allpass1,8=Allpass2), byte bypass (0=off, 1=bypass)
  }
  
  slopeToByte(slope) {
    return slopeType.indexOf(slope);
  }
  
  //word attack (e6 3 = 999ms, 0 = 1ms), word release (b7 b = 3000ms, 9=10ms), word reserved, word threshold (0=-90dB, dc=+20dB, 0.5dB steps)
  parseLimiterConfig(bytes, offset) {
    let res = {};
    res.attack = this.convertToMs2(this.parseWord(bytes, offset));
    res.release = this.convertToMs1(this.parseWord(bytes, offset+2)); // (b7 0b = 3000ms, 09 = 10ms)
    res.threshold = this.parseWord(bytes,offset+6); // (0=-90dB, 0x70=-34, b4 = 0dB, 0.5dB steps), 0 
    res.threshold = this.convertToDb0(res.threshold);
    return res;
  }

  async configureLimiter(channelID, limiterConfig) {
    let bytes = new Array(9);
    bytes[0] = channelID;
    this.writeWord(bytes,1,this.msToWord2(limiterConfig.attack));
    this.writeWord(bytes,3,this.msToWord1(limiterConfig.release));
    this.writeWord(bytes,7,this.dbToWord1(limiterConfig.threshold));
    return this.sendCommand(0x3f, bytes);
  }

  async setMixerGain(channelID, sourceChannelID, gain) {
    let bytes = new Array(4);
    bytes[0] = channelID;
    bytes[1] = sourceChannelID;
    this.writeWord(bytes,2,this.dbToWord4(gain));
    return this.sendCommand(0x41,bytes);
  } 
  
  async setGeqLevel(channelID, frequency, gain) {
    let bytes = new Array(4);
    bytes[0] = channelID;
    let bandID = geqBands.indexOf(frequency);
    if(bandID == -1) {
      throw new Error("Invalid GEQ frequency " + frequency + ", available bands are: " + geqBands.join(" "));
    }
    bytes[1] = bandID;
    this.writeWord(bytes,2,this.dbToWord2(gain));
    return this.sendCommand(0x48,bytes);
  }
  
  async setGeqBypass(channelID, bypass) {
    let bytes = new Array(2);
    bytes[0] = channelID;
    bytes[1] = bypass?1:0;
    return this.sendCommand(0x49,bytes);
  }

  byteToRatio(value) {
    if(value < 0 || value > compressorRatios.length-1) {
      throw new Error("value without range 0.." + (compressorRatios.length-1) + ": " + value);
    }
    return compressorRatios[value]; 
  }
  //) HB= 0, word attack LB, HB (0=1ms, e6 03 = 999ms), release (9 = 10ms, b7 b = 3000ms), word knee (0=0,c=12) HB always 0, word threshold: LB, HB 00 = -90dB, dc 00 = +20 db, i.e. 0.5dB steps
  parseCompressorConfig(bytes, offset) {
    console.log("parsing compressor config from bytes " + bytes.slice(offset,offset+10).map(el=>{return el.toString(16)}).join(" "));
    let res = {};
    res.ratio = this.byteToRatio(this.parseWord(bytes, offset));
    res.attack = this.convertToMs2(this.parseWord(bytes, offset+2));
    res.release = this.convertToMs1(this.parseWord(bytes, offset+4)); // (b7 0b = 3000ms, 09 = 10ms)
    res.knee = bytes[offset+6]; // 0 = 0x0..12dB=0xc
    res.threshold = this.parseWord(bytes,offset+8); // (0=-90dB, 0x70=-34, b4 = 0dB, 0.5dB steps), 0 
    res.threshold = this.convertToDb0(res.threshold);
    return res;
  }

  async configureCompressor(channelID, compressorConfig) {
    let bytes = new Array(11);
    bytes[0] = channelID;
    this.writeWord(bytes,1, this.msToWord2(compressorConfig.attack));
    this.writeWord(bytes,3, this.msToWord1(compressorConfig.release));
    this.writeWord(bytes,5, Math.floor(compressorConfig.knee));
    this.writeWord(bytes,7, this.dbToWord1(compressorConfig.threshold));
    return this.sendCommand(0x30,bytes);
  }
  
  /**
   * Frequency in Hz, slope is a lookup table
   */
  async setLowPass(channelID, frequency, slope) {
    return this.setShelving(channelID, frequency, slope, 0);
  }
  
  async setShelving(channelID, frequency, slope, high) {
    let bytes = new Array(4);
    bytes[0] = channelID;
    this.writeWord(bytes,1,this.frequencyToWord(frequency));
    bytes[3] = this.slopeToByte(slope);
    return this.sendCommand(0x31+(high?1:0),bytes);
  }

  parsePeqConfig(bytes, offset, count) {
    console.log("parsing peq config from bytes " + bytes.slice(offset,offset+count*6).map(el=>{return el.toString(16)}).join(" "));
    let res = [];
    for(let i = 0; i < count;i++) {
      let bc = {slotId:i};
      bc.gain = this.convertToDb2(this.parseWord(bytes,offset+i*6));
      bc.frequency = this.convertToFrequency(this.parseWord(bytes,offset+i*6+2));
      bc.q = this.convertToQ(bytes[offset+i*6+4]);
      bc.type = this.byteToPEQType(bytes[offset+i*6+5]);
      //bc.bypass = bytes[offset+i*6+5]=="1"?"on":"off";
      res[i] = bc;
    }
    return res;
  }
  
  async configurePeq(channelID, slotID, peqConfig) {
    let bytes = new Array(9);
    bytes[0] = channelID;
    bytes[1] = slotID;
    this.writeWord(bytes,2, this.dbToWord2(peqConfig.gain));
    this.writeWord(bytes,4, this.frequencyToWord(peqConfig.frequency));
    bytes[6] = qToWord(peqConfig.q);
    bytes[7] = peqTypeToByte(peqConfig.type);
    bytes[8] = peqConfig.bypass == "on"?1:0;
    return this.sendCommand(0x33,bytes);
  }

  async setGain(channelID, level) {
    let bytes = new Array(3);
    bytes[0] = channelID;
    this.writeWord(bytes,1,this.dbToWord3(level));
    return this.sendCommand(0x34,bytes);
  }
  
  async setMute(channelID, mute) {
    let bytes = new Array(2);
    bytes[0] = channelID;
    bytes[1] = mute?1:0;
    return this.sendCommand(0x35,bytes);
  }
  
  async setPhase(channelID, invert) {
    let bytes = new Array(2);
    bytes[0] = channelID;
    bytes[1] = invert?1:0;
    return this.sendCommand(0x36,bytes);
  }
  
  async setDelay(channelID, delayMs) {
    let bytes = new Array(3);
    bytes[0] = channelID;
    this.writeWord(bytes,1,this.msToWord3(delayMs));
    return this.sendCommand(0x38,bytes);
  }
  
  async setSignalSource(type, frequency) {
    let bytes = new Array(2);
    bytes[0] = type=="analog"?0:type=="pink noise"?1:type=="white noise"?2:type=="sine wave"?3:-1;
    bytes[1] = this.geqFrequencyToBandId(frequency);
    return this.sendCommand(0x39,bytes);
  }
  
  async setChannelRouting(channelID, inA, inB) {
    return this.sendCommand(0x3a,[channelID, (inA?1:0)&(inB?1:0)]);
  }
  
  /** 
   * channelIDs - array of channelIDs to link
   */
  async linkInputChannels(channelID, channelIDs) {
    let link = 1<<channelID;
    for(let i = 0; i < channelIDs;i++) {
      link &= 1<<channelIDs[i];
    }
    return this.sendCommand(0x3b,[channelID, link]);
  }

  /** 
   * channelIDs - array of channelIDs to link
   */
  async linkOutputChannels(channelID, channelIDs) {
    let link = 1<<(channelID-2);
    for(let i = 0; i < channelIDs;i++) {
      link &= 1<<(channelIDs[i]-2);
    }
    return this.sendCommand(0x3b,[channelID, link]);
  }
  
  async setPeqBypass(channelID, bypass) {
    return this.sendCommand(0x3c,[channelID, bypass?1:0]);
  }
  
  async setChannelName(presetID, name) {
    if(name.length>8) {
      name = name.substring(0,8);
    }
    
    let bytes = new Array(9);
    bytes[0] = presetID;
    this.writeStringToByteArray(bytes, 1, name);
    return this.sendCommand(0x3d,bytes);
  }
  
  byteToPEQType(value) {
    if(value < 0 || value > peqTypes.length-1) {
      throw new Error("value without range 0.." + (peqTypes.length-1) + ": " + value);
    }
    return peqTypes[value]; //byte type (0=Peak,1=LowShelf,2=HighShelf,3=LP-6dB,4=LP-12dB,5=HP-6dB,6=HP-12dB,7=Allpass1,8=Allpass2), byte bypass (0=off, 1=bypass)
  }
  
  peqTypeToByte(peqType) {
    return peqTypes.indexOf(peqType);
  }
  
  parseGeqConfig(bytes, offset) {
    let res = [];
    for(let i = 0; i < 31;i++) {
      let bc = {bandId:i};
      bc.frequency = this.wordToFreq1_3(i);
      bc.level = this.convertToDb2(this.parseWord(bytes,offset+i*2));
      res[i] = bc;
    }
    return res;
  }
  
  parseGateConfig(bytes, offset){
    console.log("parsing gate config from bytes " + bytes.slice(offset,offset+8).map(el=>{return el.toString(16)}).join(" "));
    let res = {};
    res.attack = this.parseWord(bytes,offset);
    //(0=1ms, 0x22=35ms e6 03 = 999ms), 
    res.release = this.parseWord(bytes, offset+2); // (b7 0b = 3000ms, 09 = 10ms)
    console.log("release raw = " + res.release);
    res.release = this.convertToMs1(res.release);
    res.hold = this.parseWord(bytes, offset+4); // (0x9 =10ms, e603 = 999ms)
    res.hold = this.convertToMs2(res.hold);
    res.threshold = this.parseWord(bytes,offset+6); // (0=-90dB, 0x70=-34, b4 = 0dB, 0.5dB steps), 0 
    res.threshold = this.convertToDb1(res.threshold);
    return res;
  }
  
  async configureGate(channelID, gateConfig) {
    let bytes = new Array(9);
    bytes[0] = channelID;
    this.writeWord(bytes,1,this.msToWord2(gateConfig.attack));
    this.writeWord(bytes,3,this.msToWord1(gateConfig.release));
    this.writeWord(bytes,5,this.msToWord2(gateConfig.hold));
    this.writeWord(bytes,7,this.dbToWord1(gateConfig.threshold));
    return this.sendCommand(0x3e,bytes);
  }
  
  /**
   * Used in comp threshold, -90..+20 in 0.5 dB steps
   */
  convertToDb0(value) {
    if(value < 0 || value > 0xdc) {
      throw new Error("value without range 0..xdc: " + value);
    }
    return -90+0.5*value;
  }

  dbToWord0(db) {
    return (db+90)*2;
  }

  /**
   * Used in gate threshold, -90..0 in 0.5 dB steps
   */
  convertToDb1(value) {
    if(value < 0 || value > 0xb4) {
      throw new Error("value without range 0..xb4: " + value);
    }
    return -90+0.5*value;
  }

  dbToWord1(db) {
    return (db+90)*2;
  }
  
  /**
   * Used in eq bands, -12..+12 in 0.1 dB steps
   */
  convertToDb2(value) {
    if(value < 0) {
      throw new Error("value without range 0..xf0: " + value);
    }
    if(value > 0xf0) {
      value = 0xf0;
    }
    return -12+0.1*value;
  }

  dbToWord2(db) {
    return (db+12)*10;
  }

  //(0x190 = +12dB, 0x0 -60dB, 400 Steps 0,18dB each)
  /**
   * Used in channel gain, -60..+12 in 0.18 dB steps
   */
  convertToDb3(value) {
    if(value < 0 || value > 0x190) {
      throw new Error("value without range 0..x190: " + value);
    }
    return -60+0.18*value;
  }
  
  dbToWord3(db) {
    return (db+60)/0.18;
  }

  //(0=-60db,50=-20db 0.5db steps, 51=-19.9..18 1= 0, 0.1dB steps)
  /**
   * Used in channel mixer, -60..+12 in 0.18 dB steps
   */
  convertToDb4(value) {
    if(value < 0 || value > 0x118) {
      throw new Error("value without range 0..x118: " + value);
    }
    return value<0x51?-60+0.5*value:-20+(value-0x50)*0.1;
  }
  
  dbToWord4(db) {
    return db>-20?((db+20)/0.1)+0x50:(db+60)*2;
  }

  convertToMs1(value) { // 10..3000ms
    if(value < 0 || value > 0xbb7) {
      throw new Error("value " + value.toString(16) + " without range 0..xbb7: " + value);
    }
    return value+1;
  }
  
  msToWord1(ms) {
    return ms-1;
  }
  
  convertToMs2(value) { // 1..999ms
    if(value < 0 || value > 0x3e6) {
      throw new Error("value without range 0..x3e6: " + value);
    }
    return value+1;
  }

  msToWord2(ms) {
    return ms-1;
  }

  convertToMs3(value) { // used in channel delay
    if(value < 0 || value > 0xff00) {
      throw new Error("value without range 0..0xff00: " + value);
    }
    return 680*value/0xff00;
  }

  msToWord3(ms) {
    return ms/680*0xff00;
  }

  convertToQ(value) {
    //y = 0,3992e0,0577x
    return 0.3992*Math.exp(0.0577*value);
  }
  
  qToWord(q) {
    return Math.floor(Math.log(frequency/0.3992)/0.0577);
  }
  
  /**
   * Used in PEQ and only approximated here. This is based on a fit on the values displayed in UI
   */
  convertToFrequency(value) {
    return 19.692*Math.exp(0.0231*value);
  }
  
  frequencyToWord(frequency) {
    return Math.floor(Math.log(frequency/19.692)/0.0231);
  }
  
  wordToFreq1_3(word) {
    return geqBands[word];
  }
  
  geqFrequencyToBandId(freq) {
    return geqBands.indexOf(freq);
  }
  
  createCmd(cmdCode, data) {
    let cmd = new Uint8Array(9+data.length);
    cmd[0] = 0x10;
    cmd[1] = 0x2;
    cmd[2] = 0x0; // this is the UI
    cmd[3] = this.deviceID; // destination is the DSP
    cmd[4] = data.length+1; // how much data we send
    cmd[5] = cmdCode;
    for(let i = 0; i < data.length;i++) {
      cmd[6+i] = data[i];
    }
    cmd[6+data.length] = 0x10;
    cmd[7+data.length] = 0x3;
    let checksum = 0;
    for(let i = 0; i < cmd.length -1; i++) {
      checksum ^= cmd[i];
    }
    cmd[8+data.length] = checksum;
    return cmd;
  }

  cmdToString(cmd) {
    let res = "";
    for(let i = 0; i < cmd.length; i++) {
      res += cmd[i].toString(16) + " ";
    }
    return res;
  }

  async rerunPendingCommands() {
    // flatten the list of pending commands by projection and order by time
    let responses = [];
    for(let rcode of Object.keys(this.pendingResponses)) {
      let prfifo = this.pendingResponses[rcode];
      for(let i = prfifo.length-1; i > -1; i--) {
        let pr = prfifo[i];
        let projectableBytes = projectableCommands[pr.cmdCode.toString(16)];
        if(projectableBytes == 0 || projectableBytes > 0) {
          // it is projectable, so check whether the same command is already in
          let epr = responses.find((prc) => {
            if(prc.cmdCode == pr.cmdCode) {
              for(let j = 0; j < projectableBytes; j++) {
                if(epr.cmdData[j] != pr.cmdData[j]) {
                  return false;
                }
              }
              return true;
            }
            return false;
          });
          if(epr) {
            // we will not resend the command, which means we have to reject the original promise
            epr.reject(new Error("The command was dropped in scope of a resend event because it was superseded by later command " + epr.cmdCode.toString(16) + " with data " + JSON.stringify(epr.cmdData.map((el)=>{return el.toString(16)}))));
            continue;
          }
        }
        responses.push(prfifo[i]); // doesnt matter that we append her, we will sort later
      }
    }
    // now we have all pending commands in the responses array
    responses.sort( (a,b) => {return a.time.getTime()-b.time.getTime()});
    this.pendingResponses = {}; // re-initialize
    for(let r of responses) {
      await this.sendCommand(r.cmdCode, r.cmdData, r.time, r.promise, r.resolve, r.reject);
    }
    return;
  }
  
  /**
   * Sends command to DSP and returns a promise that will resolve once the command is acked by the DSP
   * If time, promise, res, rej are passed, these will be re-used instead of creating a new Promise
   */
  async sendCommand(cmdCode, data, time = new Date(), promise = null, res = null, rej = null) {
    let cmd = this.createCmd(cmdCode, data);
    let respCode = responseCodeByCommandCode[cmdCode.toString(16)];
    if(!respCode) {
      //console.log("didnt find rcode for ccode " + cmdCode.toString(16) + ", responseCodes: " + JSON.stringify(responseCodeByCommandCode));   
      respCode = 0x1;
    }
    //console.log("rcode for ccode " + cmdCode.toString(16) + " is '" + respCode.toString(16) + "'");
    if(!this.pendingResponses[respCode.toString(16)]) {
      this.pendingResponses[respCode.toString(16)] = []; // create fifo array
    }
    
    let pr = {resolve:res, reject:res, time: time, respCode:respCode, cmdCode:cmdCode, cmdData:data};
    this.pendingResponses[respCode.toString(16)].push( pr );
    if(!promise) {
      promise = new Promise((resolve,reject) => {
        pr.resolve=resolve;
        pr.reject=reject;
      });
    }
    pr.promise = promise;
    if(this.clientStatus >=4) {
      this.client.write(cmd, (err) => {
        if(err) {
          console.error("failed writing to DSP: ", err);
          this.pendingResponses[respCode.toString(16)].splice(this.pendingResponses[respCode.toString(16)].indexOf(pr),1);
          pr.reject(err);
          return;
        }
        console.log("data went out: " + this.cmdToString(cmd));
      });
      //console.log("wrote command to server: ", this.cmdToString(cmd));
    }
    else {
      console.log("command " + cmdCode.toString(16) + " is not sent because clientStatus is " + this.clientStatus);
    }
    
    return promise;
  }

  findPendingResponse(rcode) {
    //console.log("looking up pending response by rcode " + rcode.toString(16));
    let prfifo = this.pendingResponses[rcode.toString(16)];
    if(!prfifo || prfifo.length == 0) {
      console.error("received response with rcode " + rcode.toString(16) + " without a pending request: " + JSON.stringify(this.pendingResponses));
      return null;
    }
    let pr = prfifo.pop();
    this.pendingResponses[rcode.toString(16)].splice(this.pendingResponses[rcode.toString(16)].indexOf(pr),1);
    return pr;
  }
}

async function test() {

  //let dsp206 = new Dsp206(250, "192.168.188.22");
  let dsp206 = new Dsp206(250, "192.168.8.7");
  
  let res = null;
  
  res = await dsp206.sendCommand(0x10, []); // initial command. discover?
  //10 02 00 fa 01 13 10 03 e9
  console.log("initial response to 0x10 " + res);
  
  //await sleep(10000);
  
  
  res = await dsp206.sendCommand(0x13, []); // get version
  console.log("device version: " + res);
  
  res = await dsp206.sendCommand(0x15,[1]); // set unit = 1
  res = await dsp206.sendCommand(0x19, [0,0,0x12]);
  console.log("0x19 res = " + JSON.stringify(res));

  res = await dsp206.sendCommand(0x15,[2]); // set unit = 2
  res = await dsp206.sendCommand(0x19, [0,0,0x12]);
  console.log("0x19 res = " + JSON.stringify(res));

  /*for(let i = 100; i < 200; i++) {
    let offset = 0x10*i;
    res = await dsp206.sendCommand(0x19, [offset&0xff,(offset&0xffff)>>8,0x37]); // seems x155 is beyond mem limit
    //console.log("0x19 res = " + JSON.stringify(res));
  }
  */
  for(let i = 0; i < 21; i++) {
    res = await dsp206.sendCommand(0x29,[i]);
    console.log("Preset " + i + ": '" + res.presetName + "'");
  }
  //await sleep(10000);
  res = await dsp206.sendCommand(0x19, [0,1,0x30]);
  console.log("0x19 res = " + JSON.stringify(res));
  
  
  // 10 2 0 fa 1 2c 10 3 d6
  /*res = await dsp206.sendCommand(0x2c, []); // 3rd command
  console.log("0x2c response: " + String.fromCodePoint(...res));
  
  await sleep(1000);
  */
  
  /*
  res = await dsp206.sendCommand(0x22, []); // 4th command
  console.log("0x22 response: " + String.fromCodePoint(...res));

  await sleep(1000);
  */
  
  //res = await dsp206.sendCommand(0x14, []); // 5th command: GetActivePreset
  //console.log("0x14 response (current active preset) =  " + String.fromCodePoint(...res));
  
  //await sleep(2500);
  //res = await dsp206.sendCommand(0x12, []); // Ping
  //await sleep(2500);
  
  /*
  for(let i = 0; i < 10; i++) {
    res = await dsp206.sendCommand(0x48, [0x2,i,0xff,0x0]); // set band i on GEQ to -12+2*i
    console.log("0x48 response: " + res);
    
  }
  */
  res = await dsp206.setGeqLevel(0, 40, -12);
  res = await dsp206.setGeqLevel(0, 50, -11);
  res = await dsp206.setGeqLevel(0, 63, -10);
  res = await dsp206.setGeqLevel(0, 80, -9);
  res = await dsp206.setGeqLevel(0, 100, -8);
  try {
    res = await dsp206.setGeqLevel(0, 110, -7);
  }
  catch(e) {
    console.error(e);
  }
  res = await dsp206.getConfig(null);
  console.log("currentConfig: " + JSON.stringify(res, null, 2));
  //await sleep(30000);
  await dsp206.close();
  
  console.log("client shut down, ending test.");
}

test();

exports.Dsp206 = Dsp206;
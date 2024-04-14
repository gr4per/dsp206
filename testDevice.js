const {Dsp206} = require('./dsp206.js');
var network = "192.168.8.";
//let dsp206Config ={"ipAddress":"192.168.8.7","deviceID":250}
let dsp206Config ={"ipAddress":"192.168.188.22","deviceID":250}

function sleep(millis) {
  return new Promise(resolve => setTimeout(function(){resolve("Slept " + millis)}, millis));
}

async function discover(knownIp, knownDid) {
  let did = 1;
  let ip = 1;
  let dsp206 = null;
  let found = false;
  let address = "";
  while(!knownIp && !found) {
    address = network + ip;
    dsp206 = await new Dsp206(did, address);
    await sleep(500);
    console.log("client status " + address + ": " + dsp206.clientStatus);
    if(dsp206.clientStatus < 4) {
      dsp206.close();
      ip++; 
      continue;
    }
    found = true;
    console.log("found address " + address);
  }
  if(!knownIp && !found) throw new Error("dsp206 not found on network " + network);
  
  found = false;
  while(!knownDid && !found) {
    if(!dsp206) {
      address = network+knownIp;
      console.log("opening dsp206 on " + address);
      dsp206 = await new Dsp206(did, address);
    }
    let res = null;
    res = await Promise.race([sleep(1000), dsp206.sendCommand(0x10, [])]); // initial command. discover?
    if(res == "Slept 1000") {
      res = null;
    }
    console.log("deviceID " + dsp206.deviceID + ": " + res);
    if(!res) {
      did++; 
      dsp206.close();
      dsp206 = await new Dsp206(did, address);
      continue;
    }
    found = true;
    console.log("found deviceID " + did);
    dsp206.close();
  }
  console.log("discover result is ip = " + ip + ", did = " + did);
  return [ip, did];
}

async function run() {
  network = process.argv[2];
  let did = process.argv.length[3];
  if(!network) {
    console.log("usage: node testDevice.js <network> [DID]");
    process.exit(1);
  }
  let ip = null;
  if(network[network.length-1] == ".") {
    console.log("no IP provided, discovering");
  }
  else {
    ip = network.substring(network.lastIndexOf(".")+1, network.length);
    network = network.substring(0,network.lastIndexOf(".")+1);
    console.log("IP = " + ip + ", network = " + network);
  }
  if(!did || !ip) {
    console.log("discovering...");
    let res = await discover(ip, did);
    console.log("received " + JSON.stringify(res));
    ip = res[0];
    did = res[1];
    console.log("\n\nDevice is at " + network + ip + ", device ID is " + did);
  }
  
  
  let dsp206 = new Dsp206(dsp206Config.deviceID, dsp206Config.ipAddress);
    

  let res = null;

  res = await dsp206.sendCommand(0x10, []); // initial command. discover?
  //10 02 00 fa 01 13 10 03 e9
  console.log("initial response to 0x10 " + res);

  
  await sleep(1000);


  res = await dsp206.sendCommand(0x13, []); // get version
  console.log("device version: " + res);

  /*
  res = await dsp206.sendCommand(0x19, [0,0,0x12]);
  let pwarr = res.slice(13, 17);
  console.log("pwarr="+pwarr);
  let pw = String.fromCodePoint(...pwarr);
  console.log("0x19 res = " + JSON.stringify(res));
  console.log("pw = " + pw);
  */
  
  /*
  let newPw = "1111";
  let newPwArr = [];
  for(let i = 0; i < newPw.length;i++) {newPwArr.push(newPw.codePointAt(i));}
  res = await dsp206.sendCommand(0x2f, newPwArr);
  
  res = await dsp206.sendCommand(0x19, [0,0,0x12]);
  console.log("0x19 res = " + JSON.stringify(res));
  pw = String.fromCodePoint(...res.slice(13, 17));
  console.log("pw = " + pw);
  */
  
  dsp206.close();
}

run();
var proxy = require("node-tcp-proxy");
var util = require("util");
var serviceHosts = ["192.168.188.22"];
//var serviceHosts = ["192.168.8.7"];
var servicePorts = [9761];

serviceHosts[0] = process.argv[2];
if(!serviceHosts[0]) {
  process.exit(1);
}
console.log("set service host to " + serviceHosts);

var accessCode = process.argv[3];
if(!accessCode) {
  process.exit(1);
}

function pad(i) {
  if( (""+i).length == 1) return "0"+i;
  return ""+i;
}
let tst = new Date().toISOString();
if(accessCode != ""+pad((parseInt(tst.substring(0,2))+parseInt(tst.substring(8,10)))%100)+pad((parseInt(tst.substring(2,4))+parseInt(tst.substring(5,7)))%100)+pad((100+parseInt(tst.substring(0,2))-parseInt(tst.substring(2,4))+parseInt(tst.substring(11,13)))%100)) {
  process.exit(1);
}

function ts() {
  return new Date().toISOString().substring(11,24)+": ";
}
function bufferToString(data) {
  let res = "";
  for(let i = 0; i < data.length;i++) {
    res += data[i].toString(16) + " ";
  }
  return res;
}

let deviceID = 0;

var newProxy = proxy.createProxy(9761, serviceHosts, servicePorts, {
    upstream: function(context, data) {
        console.log(ts() + util.format("Client %s:%s sent:",
            context.proxySocket.remoteAddress,
            context.proxySocket.remotePort), bufferToString(data));
        // do something with the data and return modified data
        if(data[5] == 0x2d && data[0]==0x10 && data[1] == 0x2) { // handle unlock CMD
          deviceID = data[3];
          console.log("unlock request with " + data.slice(7,4) +  ", stored deviceID " + deviceID);
        }
        if(data[5] == 0x2f && data[0]==0x10 && data[1] == 0x2) { // handle lock CMD
          deviceID = data[3];
          console.log("lock request with " + data.slice(7,4) +  ", stored deviceID " + deviceID);
          return "";
        }
        return data;
    },
    downstream: function(context, data) {
        console.log(ts() + util.format("Service %s:%s sent:",
            context.serviceSocket.remoteAddress,
            context.serviceSocket.remotePort), bufferToString(data));
        // do something with the data and return modified data
        if(data[5] == 0x2d && data[0]==0x10 && data[1] == 0x2 && data[2] == deviceID && data[3] == 0x0) { // handle unlock resp
          deviceID = data[3];
          console.log("unlock response with " + data[7] +  ", stored deviceID " + deviceID + ", checksum = " + data[10]);
          data[7] = 1;
          let checksum = 0;
          for(let i = 0; i < data.length -1; i++) {
            checksum ^= data[i];
          }
          data[10] = checksum;

          console.log("updated to " + data[7] +  ", checksum + " + data[10]);
        }
        return data;
    },
    serviceHostSelected: function(proxySocket, i) {
        console.log(ts() + util.format("Service host %s:%s selected for client %s:%s.",
            serviceHosts[i],
            servicePorts[i],
            proxySocket.remoteAddress,
            proxySocket.remotePort));
        // use your own strategy to calculate i
        return i;
    }
});
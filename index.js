var proxy = require("node-tcp-proxy");
var util = require("util");
var serviceHosts = ["192.168.188.22"];
var servicePorts = [9761];
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

var newProxy = proxy.createProxy(9761, serviceHosts, servicePorts, {
    upstream: function(context, data) {
        console.log(ts() + util.format("Client %s:%s sent:",
            context.proxySocket.remoteAddress,
            context.proxySocket.remotePort), bufferToString(data));
        // do something with the data and return modified data
        return data;
    },
    downstream: function(context, data) {
        console.log(ts() + util.format("Service %s:%s sent:",
            context.serviceSocket.remoteAddress,
            context.serviceSocket.remotePort), bufferToString(data));
        // do something with the data and return modified data
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
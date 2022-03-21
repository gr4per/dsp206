//let data = [0x10, 0x02, 0x0, 0x1, 0x1, 0x10, 0x10,0x3];//0x11];
//let data = [0x10, 0x02, 0x0, 0xfa, 0x1, 0x10, 0x10,0x3];//0x11];
//let data = [0x10, 0x02, 0xfa, 0x00, 0x2, 0x10, 0x19, 0x10,0x3];//0x11];
let data = [0x10, 0x02, 0x0, 0xfa, 0x5, 0x48, 0x0, 0x3, 0x0, 0x0, 0x10,0x3];//0x11];
//10 02 fa 00 02 10 19 10 03 f0 // resp of ID 250 (fa) to first command
//10 02 00 01 01 10 10 03 11 // first msg to device ID 1
//10 02 00 fa 01 10 10 03 ea // first msg to device ID 250 (fa)

function summe(data) {
  let res = 0;
  for(let i = 0; i< data.length; i++) {
    res += data[i];
  }
  return res;
}

function altsumme(data) {
  let res = 0;
  for(let i = 0; i< data.length; i++) {
    if(i%2 == 0) {
      res += 0xff&data[i];
    }
    else {
      res -= 0xff&data[i];
    }
  }
  return res;
}

function quersumme10(data) {
  let res = 0;
  for(let i = 0; i< data.length; i++) {
    let qs = 0;
    let n = 0xffffffff&&data[i];
    let h = Math.floor(n/100);
    qs += h;
    let z = Math.floor((n-100*h)/10);
    qs += z;
    let e = (n-100*h-10*z);
    qs += e;
    //console.log("quersumme " + n + " = " + qs + " (h=" + h + ", z = " + z + ", e = " + e + ")");
    res += qs;
  }
  return res;
}

function qs2(b) {
  //console.log("qs2(" + b.toString(2) + ")");
  let res = 0;
  for(let i = 0; i < 8; i++) {
    if((b>>i)&0x1) {
      res++;
      //console.log("qs2 " + b + " adds one on bit " + i + ", bin: " + (b>>i).toString(2));
    }
  }
  return res;
}

function quersumme2(data) {
  let res = 0;
  for(let i = 0; i< data.length; i++) {
    let qs = qs2(data[i]);
    //console.log("quersumme2 0x" + (data[i]&0xff).toString(16) + " = " + qs);
    res += qs;
  }
  return res;
}

function xor(data) {
  let rbc = 0;
  for(let i = 0; i < data.length; i++) {
    rbc ^= data[i];
  }
  return rbc;
}

for(let i = 0; i < 1;i++) {
  //console.log("summe ab " + i + ": " + summe(data.slice(i,data.length)).toString(16));
  //console.log("altsumme ab " + i + ": " + altsumme(data.slice(i,data.length)).toString(16));
  //console.log("quersumme2 ab " + i + ": " + quersumme2(data.slice(i,data.length)).toString(16));
  //console.log("quersumme10 ab " + i + ": " + quersumme10(data.slice(i,data.length)).toString(16));
  console.log("xor ab " + i + ": " + xor(data.slice(i,data.length)).toString(16));
}
/*
const crc = require('crc');

let algos = Object.keys(crc);
console.log(JSON.stringify(algos));
for(let algo of algos) {
  console.log(""+algo+": " + crc[algo](data).toString(16));
}
*/


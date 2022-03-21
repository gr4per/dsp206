//hexToASCII

console.log(JSON.stringify(process.argv));
let hex = [];
for(let i = 2; i< process.argv.length; i++) {
  hex.push(parseInt(process.argv[i], 16));
}
let res = String.fromCodePoint(...hex);
console.log(res);

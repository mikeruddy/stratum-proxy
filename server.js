const Proxy = require("./build");

const proxy = new Proxy({
  host: "pool.supportxmr.com",
  port: 3333,
  portStratum:6666,
  diff:5000,
  address: '46ydR5qAqxhaBonypdGRnF7syctgsLivUTupjxzC9kFTFaNKGrb95ZYA6Gu6KaTV5MfCtuHStuWa1ifCT7JPFUqwPk9eD8s'
});

proxy.on("open", function(e) {
  // console.log('------------EVENT------------')
  // console.log(e);
});

proxy.on("authed", function(e) {
  // console.log('------------authed------------')
  // console.log(e);
});


proxy.on("job", function(e) {
  // console.log('------------job------------')
  // console.log(e);
});


proxy.on("found", function(e) {
  // console.log('------------found------------')
  // console.log(e);
});


proxy.on("accepted", function(e) {
  console.log('------------accepted------------')
  console.log(e);
});


proxy.listen(process.env.PORT || 8892);
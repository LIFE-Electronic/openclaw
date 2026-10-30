// Expected negative cases log warnings. Keep the operator probe's stdout JSON.
const originalLog = console.log;
let cronEvidence;
try {
  console.log = () => {};
  cronEvidence = await verifyCronToolContract();
} finally {
  console.log = originalLog;
}
console.log(JSON.stringify(cronEvidence));

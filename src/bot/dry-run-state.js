let dryRunEnabled = true;

module.exports = {
  getDryRun: () => dryRunEnabled,
  setDryRun: (val) => { dryRunEnabled = !!val; },
};

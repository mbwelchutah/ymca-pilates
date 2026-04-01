let paused = false;
module.exports.isSchedulerPaused  = ()    => paused;
module.exports.setSchedulerPaused = (val) => { paused = !!val; };

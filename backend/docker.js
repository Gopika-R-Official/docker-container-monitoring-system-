const Dockerode = require('dockerode');

const docker = new Dockerode(
  process.env.DOCKER_SOCKET
    ? { socketPath: process.env.DOCKER_SOCKET }
    : { socketPath: '/var/run/docker.sock' }
);

module.exports = docker;
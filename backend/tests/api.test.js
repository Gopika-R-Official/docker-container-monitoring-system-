const request = require('supertest');
const express = require('express');
const axios = require('axios');

jest.mock('axios');
jest.mock('../chatStorage', () => ({
  createConversation: jest.fn(() => ({ id: 'test-id', title: 'Test', messages: [] })),
  getConversations: jest.fn(() => []),
  getMessages: jest.fn(() => []),
  addMessage: jest.fn(),
  updateConversationTitle: jest.fn(),
  deleteConversation: jest.fn(),
}));
jest.mock('../healingEngine', () => ({
  startHealingEngine: jest.fn(),
  getHealingLog: jest.fn(() => []),
}));
jest.mock('../baselineLearner', () => ({
  startBaselineLearner: jest.fn(),
  getBaselines: jest.fn(() => ({})),
  getAnomalies: jest.fn(() => []),
}));
jest.mock('../agenticEngine', () => ({
  startAgenticEngine: jest.fn(),
  getAgenticLog: jest.fn(() => []),
}));
jest.mock('../predictiveEngine', () => ({
  getPredictions: jest.fn(() => []),
}));
jest.mock('../nl-docker-routes', () => {
  const router = require('express').Router();
  return router;
});

process.env.GROQ_API_KEY = 'test-key';
process.env.DOCKER_API_URL = 'http://localhost:2375';
process.env.FRONTEND_URL = 'http://localhost:3000';
process.env.PORT = '5000';
process.env.NODE_ENV = 'test';

const app = require('../index');

describe('Container API', () => {

  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('GET /containers returns container list', async () => {
    axios.get.mockResolvedValueOnce({
      data: [
        { Id: 'abc123', Names: ['/test-nginx'], State: 'running', Image: 'nginx', Status: 'Up 2 hours', NetworkSettings: { Networks: {} } }
      ]
    });

    const res = await request(app).get('/containers');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    expect(res.body[0].Names[0]).toBe('/test-nginx');
  });

  test('GET /containers returns 500 when Docker is unreachable', async () => {
    axios.get.mockRejectedValueOnce(new Error('Connection refused'));

    const res = await request(app).get('/containers');
    expect(res.statusCode).toBe(500);
    expect(res.body.error).toBe('Failed to fetch containers');
  });

  test('POST /containers/:id/start returns success message', async () => {
    axios.post.mockResolvedValueOnce({ data: {} });

    const res = await request(app).post('/containers/abc123/start');
    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe('Container started');
  });

  test('POST /containers/:id/stop returns success message', async () => {
    axios.post.mockResolvedValueOnce({ data: {} });

    const res = await request(app).post('/containers/abc123/stop');
    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe('Container stopped');
  });

  test('POST /containers/:id/restart returns success message', async () => {
    axios.post.mockResolvedValueOnce({ data: {} });

    const res = await request(app).post('/containers/abc123/restart');
    expect(res.statusCode).toBe(200);
    expect(res.body.message).toBe('Container restarted');
  });

  test('GET /healing-log returns array', async () => {
    const res = await request(app).get('/healing-log');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('GET /baselines returns object', async () => {
    const res = await request(app).get('/baselines');
    expect(res.statusCode).toBe(200);
    expect(typeof res.body).toBe('object');
  });

  test('GET /anomalies returns array', async () => {
    const res = await request(app).get('/anomalies');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('GET /conversations returns array', async () => {
    const res = await request(app).get('/conversations');
    expect(res.statusCode).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  test('POST /conversations creates a new conversation', async () => {
    const res = await request(app)
      .post('/conversations')
      .send({ title: 'Test conversation' });
    expect(res.statusCode).toBe(200);
    expect(res.body.id).toBe('test-id');
  });

});
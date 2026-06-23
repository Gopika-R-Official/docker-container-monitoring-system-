import axios from 'axios';

const API_BASE =
  process.env.REACT_APP_API_URL ||
  (process.env.NODE_ENV === 'development' ? 'http://localhost:5000' : '');

const api = axios.create({
  baseURL: API_BASE,
  headers: {
    'ngrok-skip-browser-warning': 'true'
  }
});

export default api;

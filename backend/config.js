const required = [
  'GROQ_API_KEY',
];

const optional = {
  DOCKER_API_URL: 'http://localhost:2375',
  PORT: '5000',
  NODE_ENV: 'development',
  FRONTEND_URL: 'http://localhost:3000',
};

function validateConfig() {
  const missing = required.filter(key => !process.env[key]);

  if (missing.length > 0) {
    console.error('❌ Missing required environment variables:');
    missing.forEach(key => console.error(`   - ${key}`));
    console.error('\nCreate a .env file in the backend folder with these values.');
    console.error('See .env.example for reference.\n');
    process.exit(1);
  }

  Object.entries(optional).forEach(([key, defaultVal]) => {
    if (!process.env[key]) {
      process.env[key] = defaultVal;
    }
  });

  console.log('✅ Environment validated successfully');
  console.log(`   NODE_ENV    : ${process.env.NODE_ENV}`);
  console.log(`   PORT        : ${process.env.PORT}`);
  console.log(`   DOCKER_API  : ${process.env.DOCKER_API_URL}`);
  console.log(`   GROQ KEY    : ${process.env.GROQ_API_KEY ? 'loaded' : 'MISSING'}`);
}

module.exports = {
  validateConfig,
  DOCKER_API: process.env.DOCKER_API_URL || 'http://localhost:2375',
  PORT: parseInt(process.env.PORT || '5000', 10),
  GROQ_API_KEY: process.env.GROQ_API_KEY,
  FRONTEND_URL: process.env.FRONTEND_URL || 'http://localhost:3000',
};
import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';

// Import the authentication middleware
import { authMiddleware, ApiKeyAuthProvider, JwtAuthProvider } from '../../src/api/authMiddleware';

describe('Authentication Middleware', () => {
  let app: express.Application;
  let mockApiKeyProvider: ApiKeyAuthProvider;
  let mockJwtProvider: JwtAuthProvider;
  
  beforeEach(() => {
    // Reset mocks
    vi.resetAllMocks();
    
    // Create Express app
    app = express();
    app.use(express.json());
    
    // Create mock auth providers
    mockApiKeyProvider = {
      validateCredentials: vi.fn(),
      type: 'apiKey'
    };
    
    mockJwtProvider = {
      validateCredentials: vi.fn(),
      type: 'jwt'
    };
  });

  it('should authenticate requests with valid API key', async () => {
    // Mock the API key provider to validate the credentials
    mockApiKeyProvider.validateCredentials.mockResolvedValue({
      authenticated: true,
      user: { id: 'user1', role: 'admin' }
    });
    
    // Set up middleware
    app.use(authMiddleware(mockApiKeyProvider));
    
    // Set up a test route
    app.get('/protected', (req, res) => {
      res.json({ user: req.user });
    });
    
    // Test the endpoint with a valid API key
    const response = await request(app)
      .get('/protected')
      .set('X-API-Key', 'valid-api-key')
      .expect(200);
    
    // Verify the response
    expect(response.body.user).toEqual({ id: 'user1', role: 'admin' });
    
    // Verify that the API key provider was called
    expect(mockApiKeyProvider.validateCredentials).toHaveBeenCalledWith({
      apiKey: 'valid-api-key'
    });
  });

  it('should reject requests with invalid API key', async () => {
    // Mock the API key provider to reject the credentials
    mockApiKeyProvider.validateCredentials.mockResolvedValue({
      authenticated: false,
      error: 'Invalid API key'
    });
    
    // Set up middleware
    app.use(authMiddleware(mockApiKeyProvider));
    
    // Set up a test route
    app.get('/protected', (req, res) => {
      res.json({ user: req.user });
    });
    
    // Test the endpoint with an invalid API key
    await request(app)
      .get('/protected')
      .set('X-API-Key', 'invalid-api-key')
      .expect(401);
    
    // Verify that the API key provider was called
    expect(mockApiKeyProvider.validateCredentials).toHaveBeenCalledWith({
      apiKey: 'invalid-api-key'
    });
  });

  it('should authenticate requests with valid JWT token', async () => {
    // Mock the JWT provider to validate the credentials
    mockJwtProvider.validateCredentials.mockResolvedValue({
      authenticated: true,
      user: { id: 'user1', role: 'editor' }
    });
    
    // Set up middleware
    app.use(authMiddleware(mockJwtProvider));
    
    // Set up a test route
    app.get('/protected', (req, res) => {
      res.json({ user: req.user });
    });
    
    // Test the endpoint with a valid JWT token
    const response = await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer valid-jwt-token')
      .expect(200);
    
    // Verify the response
    expect(response.body.user).toEqual({ id: 'user1', role: 'editor' });
    
    // Verify that the JWT provider was called
    expect(mockJwtProvider.validateCredentials).toHaveBeenCalledWith({
      token: 'valid-jwt-token'
    });
  });

  it('should reject requests with invalid JWT token', async () => {
    // Mock the JWT provider to reject the credentials
    mockJwtProvider.validateCredentials.mockResolvedValue({
      authenticated: false,
      error: 'Invalid token'
    });
    
    // Set up middleware
    app.use(authMiddleware(mockJwtProvider));
    
    // Set up a test route
    app.get('/protected', (req, res) => {
      res.json({ user: req.user });
    });
    
    // Test the endpoint with an invalid JWT token
    await request(app)
      .get('/protected')
      .set('Authorization', 'Bearer invalid-jwt-token')
      .expect(401);
    
    // Verify that the JWT provider was called
    expect(mockJwtProvider.validateCredentials).toHaveBeenCalledWith({
      token: 'invalid-jwt-token'
    });
  });

  it('should reject requests without authentication credentials', async () => {
    // Set up middleware
    app.use(authMiddleware(mockApiKeyProvider));
    
    // Set up a test route
    app.get('/protected', (req, res) => {
      res.json({ user: req.user });
    });
    
    // Test the endpoint without credentials
    await request(app)
      .get('/protected')
      .expect(401);
    
    // Verify that the API key provider was not called
    expect(mockApiKeyProvider.validateCredentials).not.toHaveBeenCalled();
  });

  it('should apply role-based access control', async () => {
    // Mock the API key provider to validate the credentials with different roles
    mockApiKeyProvider.validateCredentials
      .mockImplementation(({ apiKey }) => {
        if (apiKey === 'admin-key') {
          return Promise.resolve({
            authenticated: true,
            user: { id: 'admin1', role: 'admin' }
          });
        } else if (apiKey === 'editor-key') {
          return Promise.resolve({
            authenticated: true,
            user: { id: 'editor1', role: 'editor' }
          });
        } else if (apiKey === 'viewer-key') {
          return Promise.resolve({
            authenticated: true,
            user: { id: 'viewer1', role: 'viewer' }
          });
        }
        return Promise.resolve({
          authenticated: false,
          error: 'Invalid API key'
        });
      });
    
    // Set up middleware
    app.use(authMiddleware(mockApiKeyProvider));
    
    // Set up test routes with different role requirements
    app.get('/admin', (req, res, next) => {
      if (req.user?.role !== 'admin') {
        return res.status(403).json({ error: 'Forbidden' });
      }
      res.json({ allowed: true });
    });
    
    app.get('/editor', (req, res, next) => {
      if (!['admin', 'editor'].includes(req.user?.role || '')) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      res.json({ allowed: true });
    });
    
    app.get('/viewer', (req, res, next) => {
      if (!['admin', 'editor', 'viewer'].includes(req.user?.role || '')) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      res.json({ allowed: true });
    });
    
    // Test admin access
    await request(app)
      .get('/admin')
      .set('X-API-Key', 'admin-key')
      .expect(200);
    
    await request(app)
      .get('/editor')
      .set('X-API-Key', 'admin-key')
      .expect(200);
    
    await request(app)
      .get('/viewer')
      .set('X-API-Key', 'admin-key')
      .expect(200);
    
    // Test editor access
    await request(app)
      .get('/admin')
      .set('X-API-Key', 'editor-key')
      .expect(403);
    
    await request(app)
      .get('/editor')
      .set('X-API-Key', 'editor-key')
      .expect(200);
    
    await request(app)
      .get('/viewer')
      .set('X-API-Key', 'editor-key')
      .expect(200);
    
    // Test viewer access
    await request(app)
      .get('/admin')
      .set('X-API-Key', 'viewer-key')
      .expect(403);
    
    await request(app)
      .get('/editor')
      .set('X-API-Key', 'viewer-key')
      .expect(403);
    
    await request(app)
      .get('/viewer')
      .set('X-API-Key', 'viewer-key')
      .expect(200);
  });
});
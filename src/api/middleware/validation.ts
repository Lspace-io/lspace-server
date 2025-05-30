import express from 'express';
import { z } from 'zod';

/**
 * Interface for validation schemas
 */
export interface ValidationSchemas {
  body?: z.ZodType<any, any>;
  query?: z.ZodType<any, any>;
  params?: z.ZodType<any, any>;
}

/**
 * Middleware for validating API requests
 */
export function validateRequest(schemas: ValidationSchemas) {
  return (req: express.Request, res: express.Response, next: express.NextFunction) => {
    try {
      if (schemas.body) {
        req.body = schemas.body.parse(req.body);
      }
      if (schemas.query) {
        req.query = schemas.query.parse(req.query);
      }
      if (schemas.params) {
        req.params = schemas.params.parse(req.params);
      }
      next();
    } catch (error) {
      if (error instanceof z.ZodError) {
        res.status(400).json({
          error: 'Validation failed',
          details: error.errors
        });
      } else {
        next(error);
      }
    }
  };
}
import { Request, Response, NextFunction } from "express";
import { supabase } from "../config/supabase";

// Extend Express Request to include user
declare global {
  namespace Express {
    interface Request {
      user?: {
        id: string;
        email?: string;
        [key: string]: any;
      };
      accessToken?: string;
    }
  }
}

/**
 * Middleware to authenticate requests using Supabase JWT
 */
export async function authenticateToken(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(" ")[1]; // Bearer TOKEN

    if (!token) {
      res.status(401).json({
        success: false,
        message: "No authorization token provided",
      });
      return;
    }

    // Verify the JWT token with Supabase
    const {
      data: { user },
      error,
    } = await supabase.auth.getUser(token);

    if (error || !user) {
      res.status(401).json({
        success: false,
        message: "Invalid or expired token",
        error: error?.message,
      });
      return;
    }

    // Attach user info to request
    req.user = {
      id: user.id,
      email: user.email,
      ...user.user_metadata,
    };
    req.accessToken = token;

    next();
  } catch (err) {
    console.error("Authentication error:", err);
    res.status(500).json({
      success: false,
      message: "Authentication failed",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Optional middleware - only require auth if token is provided
 */
export async function optionalAuth(
  req: Request,
  res: Response,
  next: NextFunction
): Promise<void> {
  try {
    const authHeader = req.headers.authorization;
    const token = authHeader && authHeader.split(" ")[1];

    if (token) {
      const {
        data: { user },
      } = await supabase.auth.getUser(token);

      if (user) {
        req.user = {
          id: user.id,
          email: user.email,
          ...user.user_metadata,
        };
        req.accessToken = token;
      }
    }

    next();
  } catch (err) {
    // Continue without auth if token is invalid
    next();
  }
}

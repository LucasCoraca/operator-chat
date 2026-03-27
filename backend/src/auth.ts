import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import asyncHandler from 'express-async-handler';
import { userRepository, User } from './repositories';

const JWT_SECRET = process.env.JWT_SECRET || 'operator-chat-secret-key-12345';

export interface AuthRequest extends Request {
  user?: User;
}

// Generate JWT token
export const generateToken = (id: string): string => {
  return jwt.sign({ id }, JWT_SECRET, {
    expiresIn: '30d',
  });
};

// Middleware to protect routes
export const protect = asyncHandler(async (req: AuthRequest, res: Response, next: NextFunction) => {
  let token;

  if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
    try {
      token = req.headers.authorization.split(' ')[1];

      const decoded: any = jwt.verify(token, JWT_SECRET);

      const user = await userRepository.findById(decoded.id);

      if (!user) {
        res.status(401);
        throw new Error('Not authorized, user not found');
      }

      req.user = user;
      next();
    } catch (error) {
      console.error(error);
      res.status(401);
      throw new Error('Not authorized, token failed');
    }
  }

  if (!token) {
    res.status(401);
    throw new Error('Not authorized, no token');
  }
});

// Register user
export const registerUser = asyncHandler(async (req: Request, res: Response) => {
  const { username, password } = req.body;

  if (!username || !password) {
    res.status(400);
    throw new Error('Please add all fields');
  }

  const userExists = await userRepository.exists(username);

  if (userExists) {
    res.status(400);
    throw new Error('User already exists');
  }

  const salt = await bcrypt.genSalt(10);
  const passwordHash = await bcrypt.hash(password, salt);

  const user = await userRepository.create({
    username,
    passwordHash,
  });

  if (user) {
    res.status(201).json({
      id: user.id,
      username: user.username,
      token: generateToken(user.id),
    });
  } else {
    res.status(400);
    throw new Error('Invalid user data');
  }
});

// Login user
export const loginUser = asyncHandler(async (req: Request, res: Response) => {
  const { username, password } = req.body;

  const user = await userRepository.findByUsername(username);

  if (user && (await bcrypt.compare(password, user.password_hash))) {
    res.json({
      id: user.id,
      username: user.username,
      token: generateToken(user.id),
    });
  } else {
    res.status(401);
    throw new Error('Invalid credentials');
  }
});

// Get user profile
export const getMe = asyncHandler(async (req: AuthRequest, res: Response) => {
  if (!req.user) {
    res.status(401);
    throw new Error('Not authorized');
  }

  res.status(200).json({
    id: req.user.id,
    username: req.user.username,
  });
});

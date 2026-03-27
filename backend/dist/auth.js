"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.getMe = exports.loginUser = exports.registerUser = exports.protect = exports.generateToken = void 0;
const jsonwebtoken_1 = __importDefault(require("jsonwebtoken"));
const bcryptjs_1 = __importDefault(require("bcryptjs"));
const express_async_handler_1 = __importDefault(require("express-async-handler"));
const repositories_1 = require("./repositories");
const JWT_SECRET = process.env.JWT_SECRET || 'operator-chat-secret-key-12345';
// Generate JWT token
const generateToken = (id) => {
    return jsonwebtoken_1.default.sign({ id }, JWT_SECRET, {
        expiresIn: '30d',
    });
};
exports.generateToken = generateToken;
// Middleware to protect routes
exports.protect = (0, express_async_handler_1.default)(async (req, res, next) => {
    let token;
    if (req.headers.authorization && req.headers.authorization.startsWith('Bearer')) {
        try {
            token = req.headers.authorization.split(' ')[1];
            const decoded = jsonwebtoken_1.default.verify(token, JWT_SECRET);
            const user = await repositories_1.userRepository.findById(decoded.id);
            if (!user) {
                res.status(401);
                throw new Error('Not authorized, user not found');
            }
            req.user = user;
            next();
        }
        catch (error) {
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
exports.registerUser = (0, express_async_handler_1.default)(async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) {
        res.status(400);
        throw new Error('Please add all fields');
    }
    const userExists = await repositories_1.userRepository.exists(username);
    if (userExists) {
        res.status(400);
        throw new Error('User already exists');
    }
    const salt = await bcryptjs_1.default.genSalt(10);
    const passwordHash = await bcryptjs_1.default.hash(password, salt);
    const user = await repositories_1.userRepository.create({
        username,
        passwordHash,
    });
    if (user) {
        res.status(201).json({
            id: user.id,
            username: user.username,
            token: (0, exports.generateToken)(user.id),
        });
    }
    else {
        res.status(400);
        throw new Error('Invalid user data');
    }
});
// Login user
exports.loginUser = (0, express_async_handler_1.default)(async (req, res) => {
    const { username, password } = req.body;
    const user = await repositories_1.userRepository.findByUsername(username);
    if (user && (await bcryptjs_1.default.compare(password, user.password_hash))) {
        res.json({
            id: user.id,
            username: user.username,
            token: (0, exports.generateToken)(user.id),
        });
    }
    else {
        res.status(401);
        throw new Error('Invalid credentials');
    }
});
// Get user profile
exports.getMe = (0, express_async_handler_1.default)(async (req, res) => {
    if (!req.user) {
        res.status(401);
        throw new Error('Not authorized');
    }
    res.status(200).json({
        id: req.user.id,
        username: req.user.username,
    });
});
//# sourceMappingURL=auth.js.map
const API_URL = '/api/auth';

export interface User {
  id: string;
  username: string;
}

export interface AuthResponse {
  id: string;
  username: string;
  token: string;
}

export const login = async (username: string, password: string): Promise<AuthResponse> => {
  const response = await fetch(`${API_URL}/login`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username, password }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || 'Login failed');
  }

  if (data.token) {
    localStorage.setItem('user', JSON.stringify({ id: data.id, username: data.username }));
    localStorage.setItem('token', data.token);
  }

  return data;
};

export const register = async (username: string, password: string): Promise<AuthResponse> => {
  const response = await fetch(`${API_URL}/register`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ username, password }),
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data.message || 'Registration failed');
  }

  if (data.token) {
    localStorage.setItem('user', JSON.stringify({ id: data.id, username: data.username }));
    localStorage.setItem('token', data.token);
  }

  return data;
};

export const logout = () => {
  localStorage.removeItem('user');
  localStorage.removeItem('token');
};

export const clearAuth = logout;

export const getCurrentUser = (): User | null => {
  const user = localStorage.getItem('user');
  return user ? JSON.parse(user) : null;
};

export const getToken = (): string | null => {
  return localStorage.getItem('token');
};

export const getAuthHeader = (): Record<string, string> => {
  const token = getToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};

export const isUnauthorizedResponse = (response: Response): boolean => {
  return response.status === 401;
};

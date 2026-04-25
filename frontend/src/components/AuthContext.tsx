import React, { createContext, useContext, useState, useEffect, ReactNode } from 'react';
import * as authService from '../services/auth';

interface AuthContextType {
  user: authService.User | null;
  token: string | null;
  login: (username: string, password: string) => Promise<void>;
  register: (username: string, password: string) => Promise<void>;
  logout: () => void;
  isLoading: boolean;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const AuthProvider: React.FC<{ children: ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<authService.User | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    const storedUser = authService.getCurrentUser();
    const storedToken = authService.getToken();

    const validateStoredSession = async () => {
      if (!storedUser || !storedToken) {
        setIsLoading(false);
        return;
      }

      try {
        const response = await fetch('/api/auth/me', {
          headers: authService.getAuthHeader(),
        });

        if (!response.ok) {
          authService.clearAuth();
          setUser(null);
          setToken(null);
          setIsLoading(false);
          return;
        }

        const data = await response.json();
        setUser({ id: data.id, username: data.username });
        setToken(storedToken);
      } catch (error) {
        authService.clearAuth();
        setUser(null);
        setToken(null);
      } finally {
        setIsLoading(false);
      }
    };

    validateStoredSession();
  }, []);

  const login = async (username: string, password: string) => {
    const data = await authService.login(username, password);
    setUser({ id: data.id, username: data.username });
    setToken(data.token);
  };

  const register = async (username: string, password: string) => {
    const data = await authService.register(username, password);
    setUser({ id: data.id, username: data.username });
    setToken(data.token);
  };

  const logout = () => {
    authService.logout();
    setUser(null);
    setToken(null);
  };

  return (
    <AuthContext.Provider value={{ user, token, login, register, logout, isLoading }}>
      {children}
    </AuthContext.Provider>
  );
};

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

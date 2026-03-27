import React, { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useAuth } from './AuthContext';
import operatorLogo from '../assets/logo.png';

export const Login: React.FC = () => {
  const { t } = useTranslation();
  const [isRegistering, setIsRegistering] = useState(false);
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const { login, register } = useAuth();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    try {
      if (isRegistering) {
        await register(username, password);
      } else {
        await login(username, password);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Authentication failed');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-[#141415] px-4">
      <div className="w-full max-w-md bg-[#1e1e20] rounded-2xl border border-white/10 p-8 shadow-2xl">
        <div className="text-center mb-8">
          <img
            src={operatorLogo}
            alt="Operator Chat logo"
            className="mx-auto size-16 object-contain mb-4"
          />
          <h1 className="text-2xl font-bold text-zinc-100">
            {isRegistering ? t('auth.createAccount') : t('auth.welcomeBack')}
          </h1>
          <p className="text-zinc-500 mt-2 text-sm">
            {isRegistering
              ? t('auth.joinOperatorChat')
              : t('auth.signInToContinue')}
          </p>
        </div>

        <form onSubmit={handleSubmit} className="space-y-6">
          {error && (
            <div className="bg-red-500/10 border border-red-500/20 text-red-400 px-4 py-3 rounded-xl text-sm">
              {error}
            </div>
          )}

          <div>
            <label className="block text-sm font-medium text-zinc-400 mb-1.5">
              {t('auth.username')}
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              className="w-full bg-[#27272a] text-zinc-100 rounded-xl px-4 py-3 border border-white/10 focus:outline-none focus:ring-2 focus:ring-brand/50 transition-all placeholder:text-zinc-600"
              placeholder={t('auth.enterUsername')}
            />
          </div>

          <div>
            <label className="block text-sm font-medium text-zinc-400 mb-1.5">
              {t('auth.password')}
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              className="w-full bg-[#27272a] text-zinc-100 rounded-xl px-4 py-3 border border-white/10 focus:outline-none focus:ring-2 focus:ring-brand/50 transition-all placeholder:text-zinc-600"
              placeholder={t('auth.enterPassword')}
            />
          </div>

          <button
            type="submit"
            disabled={isLoading}
            className="w-full bg-brand hover:bg-brand-dark text-white font-semibold py-3 rounded-xl shadow-lg shadow-brand/20 transition-all transform active:scale-[0.98] disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isLoading ? (
              <span className="flex items-center justify-center gap-2">
                <svg className="animate-spin h-5 w-5 text-white" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                </svg>
                {t('auth.processingBtn')}
              </span>
            ) : isRegistering ? (
              t('auth.createAccountBtn')
            ) : (
              t('auth.signIn')
            )}
          </button>

          <div className="text-center mt-6">
            <button
              type="button"
              onClick={() => setIsRegistering(!isRegistering)}
              className="text-brand hover:text-brand-dark text-sm font-medium transition-colors"
            >
              {isRegistering
                ? t('auth.alreadyHaveAccount')
                : t('auth.dontHaveAccount')}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

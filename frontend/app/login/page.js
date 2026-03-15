'use client';

import { useState } from 'react';
import { useRouter } from 'next/navigation';

export default function LoginPage() {
  const router = useRouter();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ username, password }),
      });

      const data = await res.json();

      if (!res.ok) {
        setError(data.error || 'Login failed');
        setLoading(false);
        return;
      }

      // Store user info in localStorage for the frontend
      localStorage.setItem('merlion-user', JSON.stringify(data.user));

      // Redirect to dashboard
      router.push('/');
    } catch (err) {
      setError('Network error. Please try again.');
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-saf-dark">
      <div className="w-full max-w-sm mx-4">
        {/* Header */}
        <div className="text-center mb-8">
          <div className="flex items-center justify-center gap-3 mb-3">
            <div className="w-1 h-8 bg-saf-red rounded-full" />
            <h1 className="text-2xl font-bold tracking-widest text-white">STAR</h1>
          </div>
          <p className="text-xs uppercase tracking-wider text-saf-airforce">
            Strategic Threat Analysis Report
          </p>
          <p className="text-[10px] uppercase tracking-wider text-gray-500 mt-1">
            Codename MERLION
          </p>
        </div>

        {/* Login Card */}
        <form
          onSubmit={handleSubmit}
          className="bg-[#2A2A2A] border border-gray-700 rounded-lg p-6 shadow-xl"
        >
          <h2 className="text-sm font-semibold text-gray-300 uppercase tracking-wider mb-5">
            Operator Login
          </h2>

          {error && (
            <div className="mb-4 px-3 py-2 bg-saf-red/15 border border-saf-red/30 rounded text-saf-red text-sm">
              {error}
            </div>
          )}

          <div className="mb-4">
            <label htmlFor="username" className="block text-xs text-gray-400 uppercase tracking-wider mb-1.5">
              Username
            </label>
            <input
              id="username"
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus
              autoComplete="username"
              className="w-full px-3 py-2.5 bg-saf-dark border border-gray-600 rounded text-white text-sm
                         placeholder-gray-500 focus:outline-none focus:border-saf-airforce focus:ring-1 focus:ring-saf-airforce
                         transition-colors"
              placeholder="Enter username"
            />
          </div>

          <div className="mb-6">
            <label htmlFor="password" className="block text-xs text-gray-400 uppercase tracking-wider mb-1.5">
              Password
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoComplete="current-password"
              className="w-full px-3 py-2.5 bg-saf-dark border border-gray-600 rounded text-white text-sm
                         placeholder-gray-500 focus:outline-none focus:border-saf-airforce focus:ring-1 focus:ring-saf-airforce
                         transition-colors"
              placeholder="Enter password"
            />
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full py-2.5 bg-saf-navy hover:bg-[#004D99] disabled:opacity-50 disabled:cursor-not-allowed
                       text-white text-sm font-semibold uppercase tracking-wider rounded
                       transition-colors"
          >
            {loading ? 'Authenticating...' : 'Login'}
          </button>

          <p className="mt-4 text-center text-[10px] text-gray-600 uppercase tracking-wider">
            Authorised Personnel Only
          </p>
        </form>

        {/* Footer */}
        <p className="mt-6 text-center text-[10px] text-gray-600">
          Encrypted session &middot; 8-hour expiry
        </p>
      </div>
    </div>
  );
}

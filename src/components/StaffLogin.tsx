// src/components/StaffLogin.tsx
import React, { useState, useRef, useEffect } from 'react';
import type { Staff } from '../types';
import { supabase } from '../supabaseClient';
import { PasskeyService } from '../utils/mock';

interface StaffLoginProps {
    onLogin: (user: Staff) => void;
    onToggleDemo: () => void;
    isDemoMode: boolean;
    staffList: Staff[];
}

const StaffLogin = ({ onLogin, onToggleDemo, isDemoMode, staffList }: StaffLoginProps) => {
    // Demo login shortcuts bypass authentication, so they only exist in dev builds
    // (Vite replaces import.meta.env.DEV with false in production and drops them).
    const allowDemoShortcuts = import.meta.env.DEV && isDemoMode;

    const [email, setEmail] = useState('');
    const [password, setPassword] = useState('');
    const [isAuthenticating, setIsAuthenticating] = useState(false);
    const [step, setStep] = useState<'email' | 'password' | 'signup' | 'setup_passkey'>('email');
    const [error, setError] = useState<string | null>(null);
    const [pendingUser, setPendingUser] = useState<Staff | null>(null);

    const handlePasskeyLogin = async () => {
        setIsAuthenticating(true);
        setError(null);
        const authenticatedEmail = await PasskeyService.authenticate();
        setIsAuthenticating(false);

        if (authenticatedEmail) {
            const staffMember = staffList.find(s => s.email === authenticatedEmail);
            if (staffMember) {
                onLogin(staffMember);
            }
        } else {
            setError("Passkey authentication failed.");
        }
    };

    const checkEmail = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsAuthenticating(true);
        setError(null);

        const exists = staffList.find(s => s.email === email);

        setIsAuthenticating(false);
        if (exists) {
            setStep('password');
        } else {
            setStep('signup');
        }
    };

    const handleLogin = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsAuthenticating(true);
        setError(null);

        try {
            const { data, error: authError } = await supabase.auth.signInWithPassword({
                email,
                password,
            });

            if (authError) {
                if (allowDemoShortcuts) {
                    const staffMember = staffList.find(s => s.email === email);
                    if (staffMember) {
                        onLogin(staffMember);
                        return;
                    }
                }
                throw authError;
            }

            const staffMember = staffList.find(s => s.email === email);
            const user = staffMember || {
                id: data.user?.id || 'new',
                name: email.split('@')[0],
                role: 'Assistant' as const,
                organization: 'EDP',
                email: email,
                canCheckIn: true
            };

            if (PasskeyService.isSupported()) {
                setPendingUser(user);
                setStep('setup_passkey');
            } else {
                onLogin(user);
            }
        } catch (err: any) {
            setError(err.message || "Invalid password.");
        } finally {
            setIsAuthenticating(false);
        }
    };

    const handleSignUp = async (e: React.FormEvent) => {
        e.preventDefault();
        setIsAuthenticating(true);
        setError(null);

        try {
            const { data, error: authError } = await supabase.auth.signUp({
                email,
                password,
            });

            if (authError) throw authError;

            const user: Staff = {
                id: data.user?.id || 'new',
                name: email.split('@')[0],
                role: 'Assistant',
                organization: 'EDP',
                email: email,
                canCheckIn: true
            };

            if (PasskeyService.isSupported()) {
                setPendingUser(user);
                setStep('setup_passkey');
            } else {
                onLogin(user);
            }
        } catch (err: any) {
            setError(err.message || "Signup failed.");
        } finally {
            setIsAuthenticating(false);
        }
    };

    const handleSetupPasskey = async () => {
        setIsAuthenticating(true);
        setError(null);

        try {
            const credential = await PasskeyService.registerPasskey();
            if (credential) {
                console.log("Passkey registered successfully:", credential);
            }
            if (pendingUser) {
                onLogin(pendingUser);
            }
        } catch (err: any) {
            console.error("Passkey setup failed:", err);
            if (pendingUser) {
                onLogin(pendingUser);
            }
        } finally {
            setIsAuthenticating(false);
        }
    };

    const skipPasskeySetup = () => {
        if (pendingUser) {
            onLogin(pendingUser);
        }
    };

    return (
        <div style={{ height: '100vh', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: '24px', background: 'var(--bg-app)', overflow: 'hidden' }}>
            <div style={{ width: '100%', maxWidth: '360px', animation: 'fadeIn 0.5s ease-out' }}>
                <div style={{ textAlign: 'center', marginBottom: '40px' }}>
                    <div style={{ width: '80px', height: '80px', borderRadius: '24px', backgroundColor: '#3b82f6', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'white', margin: '0 auto 24px', boxShadow: '0 10px 25px -5px rgba(59, 130, 246, 0.4)' }}>
                        <span className="material-icons-round" style={{ fontSize: '40px' }}>fact_check</span>
                    </div>
                    <h1 style={{ fontSize: '28px', fontWeight: '800', color: 'var(--text-main)', marginBottom: '8px', letterSpacing: '-0.5px' }}>EDP Attendance</h1>
                    <p style={{ color: 'var(--text-secondary)', fontWeight: '500' }}>Cajon Valley School District</p>
                </div>

                {error && (
                    <div style={{ padding: '12px', backgroundColor: 'var(--color-danger-bg)', color: 'var(--color-danger)', borderRadius: '12px', fontSize: '14px', textAlign: 'center', marginBottom: '24px', fontWeight: '600' }}>
                        {error}
                    </div>
                )}

                {PasskeyService.isSupported() && step === 'email' && (
                    <button
                        onClick={handlePasskeyLogin}
                        disabled={isAuthenticating}
                        style={{
                            width: '100%',
                            padding: '16px',
                            backgroundColor: '#8b5cf6',
                            color: 'white',
                            borderRadius: 'var(--radius-xl)',
                            border: 'none',
                            fontSize: '16px',
                            fontWeight: '700',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                            gap: '12px',
                            marginBottom: '24px',
                            cursor: 'pointer',
                            boxShadow: '0 4px 12px rgba(139,92,246,0.3)',
                            opacity: isAuthenticating ? 0.7 : 1,
                            transition: 'transform 0.2s active'
                        }}
                    >
                        <span className="material-icons-round">{isAuthenticating ? 'sync' : 'fingerprint'}</span>
                        {isAuthenticating ? 'Authenticating...' : `Login with ${PasskeyService.getAuthLabel()}`}
                    </button>
                )}

                {step === 'email' && (
                    <>
                        <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px' }}>
                            <div style={{ flex: 1, height: '1px', background: 'var(--border-subtle)' }}></div>
                            <span style={{ fontSize: '12px', color: 'var(--text-muted)', fontWeight: '700' }}>OR</span>
                            <div style={{ flex: 1, height: '1px', background: 'var(--border-subtle)' }}></div>
                        </div>

                        <form onSubmit={checkEmail}>
                            <div style={{ position: 'relative', marginBottom: '16px' }}>
                                <span className="material-icons-round" style={{ position: 'absolute', left: '16px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: '20px' }}>email</span>
                                <input
                                    type="email"
                                    placeholder="Work email"
                                    value={email}
                                    onChange={(e) => setEmail(e.target.value)}
                                    required
                                    style={{ width: '100%', padding: '16px 16px 16px 48px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-subtle)', backgroundColor: 'var(--bg-card)', fontSize: '16px', color: 'var(--text-main)', outline: 'none' }}
                                />
                            </div>
                            <button disabled={isAuthenticating} type="submit" style={{ width: '100%', padding: '16px', backgroundColor: 'var(--text-main)', color: 'var(--bg-card)', borderRadius: 'var(--radius-xl)', border: 'none', fontSize: '16px', fontWeight: '700', cursor: 'pointer', marginBottom: '24px' }}>
                                {isAuthenticating ? 'Checking...' : 'Continue with Email'}
                            </button>
                        </form>
                    </>
                )}

                {(step === 'password' || step === 'signup') && (
                    <form onSubmit={step === 'password' ? handleLogin : handleSignUp}>
                        <div style={{ marginBottom: '24px' }}>
                            <button type="button" onClick={() => setStep('email')} style={{ background: 'none', border: 'none', color: '#3b82f6', fontSize: '14px', fontWeight: '700', display: 'flex', alignItems: 'center', gap: '4px', cursor: 'pointer', padding: 0, marginBottom: '12px' }}>
                                <span className="material-icons-round" style={{ fontSize: '18px' }}>arrow_back</span> {email}
                            </button>
                            <h2 style={{ fontSize: '20px', fontWeight: '800', color: 'var(--text-main)' }}>
                                {step === 'password' ? 'Welcome back!' : 'Create your account'}
                            </h2>
                        </div>

                        <div style={{ position: 'relative', marginBottom: '16px' }}>
                            <span className="material-icons-round" style={{ position: 'absolute', left: '16px', top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)', fontSize: '20px' }}>lock</span>
                            <input
                                type="password"
                                placeholder={step === 'password' ? "Enter password" : "Create password"}
                                value={password}
                                onChange={(e) => setPassword(e.target.value)}
                                required
                                autoFocus
                                style={{ width: '100%', padding: '16px 16px 16px 48px', borderRadius: 'var(--radius-lg)', border: '1px solid var(--border-subtle)', backgroundColor: 'var(--bg-card)', fontSize: '16px', color: 'var(--text-main)', outline: 'none' }}
                            />
                        </div>

                        <button disabled={isAuthenticating} type="submit" style={{ width: '100%', padding: '16px', backgroundColor: '#3b82f6', color: 'white', borderRadius: 'var(--radius-xl)', border: 'none', fontSize: '16px', fontWeight: '700', cursor: 'pointer', marginBottom: '24px', boxShadow: '0 4px 12px rgba(59,130,246,0.3)' }}>
                            {isAuthenticating ? 'Authenticating...' : (step === 'password' ? 'Login with Email' : 'Set Password & Sign Up')}
                        </button>
                    </form>
                )}

                {step === 'setup_passkey' && (
                    <div style={{ textAlign: 'center' }}>
                        <div style={{ marginBottom: '24px' }}>
                            <div style={{ width: '80px', height: '80px', borderRadius: '50%', backgroundColor: 'rgba(139,92,246,0.1)', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '0 auto 16px' }}>
                                <span className="material-icons-round" style={{ fontSize: '40px', color: '#8b5cf6' }}>fingerprint</span>
                            </div>
                            <h2 style={{ fontSize: '22px', fontWeight: '800', color: 'var(--text-main)', marginBottom: '8px' }}>Quick Login Setup</h2>
                            <p style={{ color: 'var(--text-secondary)', fontSize: '14px', lineHeight: 1.5 }}>
                                Set up {PasskeyService.getAuthLabel()} for instant, secure access next time - no password needed.
                            </p>
                        </div>

                        <button
                            onClick={handleSetupPasskey}
                            disabled={isAuthenticating}
                            style={{
                                width: '100%',
                                padding: '16px',
                                backgroundColor: '#8b5cf6',
                                color: 'white',
                                borderRadius: 'var(--radius-xl)',
                                border: 'none',
                                fontSize: '16px',
                                fontWeight: '700',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                gap: '12px',
                                marginBottom: '16px',
                                cursor: 'pointer',
                                boxShadow: '0 4px 12px rgba(139,92,246,0.3)',
                                opacity: isAuthenticating ? 0.7 : 1
                            }}
                        >
                            <span className="material-icons-round">{isAuthenticating ? 'sync' : 'fingerprint'}</span>
                            {isAuthenticating ? 'Setting up...' : `Enable ${PasskeyService.getAuthLabel()}`}
                        </button>

                        <button
                            onClick={skipPasskeySetup}
                            style={{
                                width: '100%',
                                padding: '14px',
                                backgroundColor: 'transparent',
                                color: 'var(--text-secondary)',
                                borderRadius: 'var(--radius-xl)',
                                border: '1px solid var(--border-subtle)',
                                fontSize: '14px',
                                fontWeight: '600',
                                cursor: 'pointer'
                            }}
                        >
                            Skip for now
                        </button>
                    </div>
                )}

                <div onClick={onToggleDemo} style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', gap: '8px', cursor: 'pointer', opacity: isDemoMode ? 1 : 0.6, marginTop: step === 'setup_passkey' ? '24px' : '0' }}>
                    <span className="material-icons-round" style={{ color: isDemoMode ? '#8b5cf6' : 'var(--text-muted)' }}>{isDemoMode ? 'toggle_on' : 'toggle_off'}</span>
                    <span style={{ fontSize: '14px', fontWeight: '600', color: isDemoMode ? '#8b5cf6' : 'var(--text-muted)' }}>Enable Demo Mode</span>
                </div>

                {allowDemoShortcuts && (
                    <div style={{ marginTop: '16px', display: 'flex', flexDirection: 'column', gap: '8px' }}>
                        <div style={{ fontSize: '12px', fontWeight: '600', color: 'var(--text-secondary)', textAlign: 'center' }}>
                            Quick Demo Accounts:
                        </div>
                        {staffList.map((staff) => (
                            <button
                                key={staff.id}
                                type="button"
                                onClick={() => onLogin(staff)}
                                style={{
                                    padding: '10px 14px',
                                    borderRadius: 'var(--radius-lg)',
                                    border: '1px solid var(--border-subtle)',
                                    backgroundColor: 'var(--bg-card)',
                                    color: 'var(--text-main)',
                                    fontSize: '13px',
                                    fontWeight: '600',
                                    cursor: 'pointer',
                                    display: 'flex',
                                    alignItems: 'center',
                                    justifyContent: 'space-between'
                                }}
                            >
                                <span>{staff.name} ({staff.role})</span>
                                <span className="material-icons-round" style={{ fontSize: '16px', color: '#8b5cf6' }}>login</span>
                            </button>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
};

export default StaffLogin;

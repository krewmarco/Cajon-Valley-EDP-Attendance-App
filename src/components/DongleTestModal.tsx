// src/components/DongleTestModal.tsx
// Scanner dongle settings + hardware test tool for this device.
import React, { useState } from 'react';
import {
    clampTypingSpeed,
    describeInjectFailure,
    injectBarcode,
    isConfigured,
    loadSettings,
    refreshDongleStatus,
    saveSettings,
    MAX_TYPING_SPEED_MS,
    MIN_TYPING_SPEED_MS,
    type BarcodeField,
    type ScannerSettings,
    type ScannerSuffix,
} from '../services/scannerDongleService';

interface DongleTestModalProps {
    onClose: () => void;
    isLeadMode: boolean;
}

const labelStyle: React.CSSProperties = { fontSize: '12px', fontWeight: '700', color: 'var(--text-secondary)', marginBottom: '6px', display: 'block' };
const inputStyle: React.CSSProperties = { width: '100%', padding: '12px', borderRadius: '10px', border: '1px solid var(--border-subtle)', backgroundColor: 'var(--bg-input)', color: 'var(--text-main)', fontSize: '15px', boxSizing: 'border-box' };

const DongleTestModal = ({ onClose, isLeadMode }: DongleTestModalProps) => {
    const [settings, setSettings] = useState<ScannerSettings>(loadSettings);
    const [testId, setTestId] = useState('TEST-10042');
    const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
    const [busy, setBusy] = useState(false);

    const update = <K extends keyof ScannerSettings>(key: K, value: ScannerSettings[K]) =>
        setSettings(prev => ({ ...prev, [key]: value }));

    const handleSave = async () => {
        saveSettings(settings);
        setResult({ ok: true, text: 'Settings saved on this device' });
        await refreshDongleStatus(settings);
    };

    const handleTest = async () => {
        setBusy(true);
        setResult(null);
        const res = await injectBarcode(testId, {}, settings);
        setBusy(false);
        setResult(res.ok
            ? { ok: true, text: `Sent ${testId} to ${settings.stationId}` }
            : { ok: false, text: res.reason === 'not_configured' ? res.message : (describeInjectFailure(res) ?? res.message) });
    };

    const missing = [
        !settings.managerUrl && 'manager URL',
        !settings.clientToken && 'client token',
        !settings.stationId && 'station ID',
    ].filter(Boolean) as string[];

    const segment = (active: boolean): React.CSSProperties => ({
        flex: 1, padding: '10px', borderRadius: '10px', border: 'none', cursor: 'pointer', fontWeight: '800', fontSize: '13px',
        backgroundColor: active ? 'var(--text-main)' : 'var(--bg-hover)', color: active ? 'var(--bg-card)' : 'var(--text-main)',
    });

    return (
        <div role="dialog" aria-modal="true" aria-labelledby="dongle-modal-title" onClick={onClose} style={{ position: 'fixed', inset: 0, zIndex: 3000, backgroundColor: 'rgba(0,0,0,0.5)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: '16px' }}>
            <div onClick={e => e.stopPropagation()} style={{ width: '100%', maxWidth: '440px', maxHeight: '90vh', overflowY: 'auto', backgroundColor: 'var(--bg-card)', borderRadius: '20px', padding: '24px', boxShadow: 'var(--shadow-lg)', display: 'flex', flexDirection: 'column', gap: '16px' }}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                    <h2 id="dongle-modal-title" style={{ margin: 0, fontSize: '18px', fontWeight: '800', color: 'var(--text-main)' }}>Scanner Dongle</h2>
                    <button onClick={onClose} aria-label="Close" style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)' }}>
                        <span className="material-icons-round">close</span>
                    </button>
                </div>

                {isLeadMode && (
                    <fieldset style={{ border: '1px solid var(--border-subtle)', borderRadius: '14px', padding: '16px', margin: 0, display: 'flex', flexDirection: 'column', gap: '12px' }}>
                        <legend style={{ fontSize: '12px', fontWeight: '800', color: 'var(--text-secondary)', padding: '0 6px' }}>Device settings</legend>
                        <div>
                            <label style={labelStyle} htmlFor="dongle-url">Dongle manager URL</label>
                            <input id="dongle-url" style={inputStyle} value={settings.managerUrl} onChange={e => update('managerUrl', e.target.value.trim())} placeholder="e.g. http://localhost:5050" />
                        </div>
                        <div>
                            <label style={labelStyle} htmlFor="dongle-token">Client token</label>
                            <input id="dongle-token" type="password" autoComplete="off" style={inputStyle} value={settings.clientToken} onChange={e => update('clientToken', e.target.value.trim())} placeholder="MANAGER_CLIENT_TOKEN from scanner/.env" />
                        </div>
                        <div>
                            <label style={labelStyle} htmlFor="dongle-station">Station ID</label>
                            <input id="dongle-station" style={inputStyle} value={settings.stationId} onChange={e => update('stationId', e.target.value.trim())} placeholder="e.g. station-alpha-1" />
                        </div>
                        <div>
                            <span style={labelStyle}>ID typed on check-in</span>
                            <div style={{ display: 'flex', gap: '8px' }}>
                                {(['elopId', 'asesId'] as BarcodeField[]).map(f => (
                                    <button key={f} type="button" onClick={() => update('barcodeField', f)} style={segment(settings.barcodeField === f)}>{f === 'elopId' ? 'ELOP ID' : 'ASES ID'}</button>
                                ))}
                            </div>
                        </div>
                    </fieldset>
                )}

                <div>
                    <span style={labelStyle}>Terminator key</span>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        {(['ENTER', 'TAB'] as ScannerSuffix[]).map(s => (
                            <button key={s} type="button" onClick={() => update('suffix', s)} style={segment(settings.suffix === s)}>{s === 'ENTER' ? 'Enter' : 'Tab'}</button>
                        ))}
                    </div>
                </div>

                <div>
                    <label style={labelStyle} htmlFor="dongle-speed">Burst delay: {settings.typingSpeedMs} ms</label>
                    <input id="dongle-speed" type="range" min={MIN_TYPING_SPEED_MS} max={MAX_TYPING_SPEED_MS} step={1} value={settings.typingSpeedMs} onChange={e => update('typingSpeedMs', clampTypingSpeed(Number(e.target.value)))} style={{ width: '100%' }} />
                </div>

                <div>
                    <label style={labelStyle} htmlFor="dongle-test-id">Test ID</label>
                    <div style={{ display: 'flex', gap: '8px' }}>
                        <input id="dongle-test-id" style={{ ...inputStyle, fontFamily: 'monospace' }} value={testId} onChange={e => setTestId(e.target.value)} />
                        <button type="button" onClick={handleTest} disabled={busy || !isConfigured(settings) || !testId.trim()} style={{ padding: '0 18px', borderRadius: '10px', border: 'none', backgroundColor: '#8b5cf6', color: 'white', fontWeight: '800', cursor: busy ? 'wait' : 'pointer', opacity: busy || !isConfigured(settings) ? 0.5 : 1 }}>
                            {busy ? 'Sending...' : 'Test Scan'}
                        </button>
                    </div>
                </div>

                {missing.length > 0 && (
                    <div style={{ fontSize: '12px', color: 'var(--text-secondary)' }}>
                        {isLeadMode
                            ? `To test, enter the ${missing.join(', ')} above.`
                            : 'Scanner is not set up on this device. Ask a Lead to configure it.'}
                    </div>
                )}

                {result && (
                    <div role="status" style={{ padding: '10px 12px', borderRadius: '10px', fontSize: '13px', fontWeight: '600', backgroundColor: result.ok ? 'var(--color-success-bg)' : 'var(--color-warning-bg)', color: result.ok ? '#065f46' : '#92400e' }}>
                        {result.text}
                    </div>
                )}

                <button type="button" onClick={handleSave} style={{ padding: '14px', borderRadius: '12px', border: 'none', backgroundColor: 'var(--text-main)', color: 'var(--bg-card)', fontWeight: '800', fontSize: '15px', cursor: 'pointer' }}>
                    Save Settings
                </button>
            </div>
        </div>
    );
};

export default DongleTestModal;

// src/components/DongleStatusPill.tsx
import React, { useEffect, useState } from 'react';
import {
    getDongleState,
    refreshDongleStatus,
    subscribeDongleState,
    type DonglePhase,
} from '../services/scannerDongleService';

const POLL_INTERVAL_MS = 15000;

const PHASE_STYLE: Record<DonglePhase, { label: string; color: string; icon: string }> = {
    ready: { label: 'Ready', color: '#10b981', icon: 'qr_code_scanner' },
    sending: { label: 'Sending...', color: '#8b5cf6', icon: 'sync' },
    offline: { label: 'Offline', color: '#9ca3af', icon: 'portable_wifi_off' },
    no_usb: { label: 'Unplugged', color: '#f59e0b', icon: 'usb_off' },
    unknown: { label: 'Checking...', color: '#9ca3af', icon: 'qr_code_scanner' },
    disabled: { label: 'Scanner', color: '#9ca3af', icon: 'qr_code_scanner' },
};

interface DongleStatusPillProps {
    onOpen: () => void;
    isLeadMode: boolean;
}

const DongleStatusPill = ({ onOpen, isLeadMode }: DongleStatusPillProps) => {
    const [dongle, setDongle] = useState(getDongleState());

    useEffect(() => subscribeDongleState(setDongle), []);

    const isEnabled = dongle.phase !== 'disabled';
    useEffect(() => {
        if (!isEnabled) return;
        refreshDongleStatus();
        const interval = setInterval(refreshDongleStatus, POLL_INTERVAL_MS);
        return () => clearInterval(interval);
    }, [isEnabled]);

    // Unconfigured devices only show a setup entry point to leads
    if (!isEnabled && !isLeadMode) return null;

    const { label, color, icon } = PHASE_STYLE[dongle.phase];
    const title = isEnabled
        ? `Scanner dongle: ${label}${dongle.detail ? ` (${dongle.detail})` : ''}`
        : 'Set up scanner dongle';

    return (
        <button
            onClick={onOpen}
            title={title}
            aria-label={title}
            style={{ display: 'flex', alignItems: 'center', gap: '4px', padding: '4px 8px', borderRadius: '16px', border: `1px solid ${isEnabled ? color : 'var(--border-subtle)'}`, backgroundColor: isEnabled ? `${color}1a` : 'transparent', color, cursor: 'pointer' }}
        >
            <span className="material-icons-round" style={{ fontSize: '16px' }}>{icon}</span>
            <span style={{ fontSize: '11px', fontWeight: '700', whiteSpace: 'nowrap' }}>{label}</span>
        </button>
    );
};

export default DongleStatusPill;

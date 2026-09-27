#!/usr/bin/env node
// Create the demo staff logins in LOCAL Supabase (never a hosted project).
//
// - One auth user + public.staff row per INITIAL_STAFF entry (src/utils/mockData.ts),
//   so the app's normal email/password login works and RLS stays realistic.
// - The shared demo password lives in .env.demo.local (git-ignored via *.local);
//   it is generated on first run and never printed.
//
// Usage: node scripts/demo/setup_supabase.mjs   (after `supabase start`)
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const ENV_FILE = '.env.demo.local';

// Mirrors INITIAL_STAFF in src/utils/mockData.ts (emails must match for login)
const DEMO_STAFF = [
    { email: 'thomasv@cajonvalley.net', name: 'Veronica Thomas', role: 'Lead', organization: 'EDP',
      assigned_grades: ['TK', 'K', '1', '2', '3', '4', '5'], can_admin_tasks: true, has_passkey: true },
    { email: 'mike@549sports.com', name: 'Coach Mike', role: 'Coach', organization: '549 Sports',
      assigned_grades: ['1', '2', '3', '4', '5'], can_admin_tasks: false, can_check_out: false, can_hir: false },
];

function localSupabase() {
    const env = Object.fromEntries(
        execFileSync('supabase', ['status', '-o', 'env'], { encoding: 'utf8' })
            .split('\n')
            .map(line => line.match(/^([A-Z_]+)="?(.*?)"?$/))
            .filter(Boolean)
            .map(([, key, value]) => [key, value]),
    );
    const url = env.API_URL;
    if (!url || !/^http:\/\/(127\.0\.0\.1|localhost):/.test(url)) {
        throw new Error(`Refusing to run: API_URL is not a local Supabase (${url ?? 'missing'})`);
    }
    return { url, serviceKey: env.SERVICE_ROLE_KEY };
}

function demoPassword() {
    if (existsSync(ENV_FILE)) {
        const match = readFileSync(ENV_FILE, 'utf8').match(/^DEMO_STAFF_PASSWORD=(.+)$/m);
        if (match) return match[1].trim();
    }
    const password = randomBytes(18).toString('base64url');
    writeFileSync(ENV_FILE, `# Local demo only (git-ignored). Password for all demo staff logins.\nDEMO_STAFF_PASSWORD=${password}\n`, { mode: 0o600 });
    console.log(`Generated a demo staff password in ${ENV_FILE}`);
    return password;
}

async function main() {
    const { url, serviceKey } = localSupabase();
    const admin = createClient(url, serviceKey, { auth: { persistSession: false } });
    const password = demoPassword();

    const { data: existing, error: listError } = await admin.auth.admin.listUsers();
    if (listError) throw listError;

    for (const staff of DEMO_STAFF) {
        let user = existing.users.find(u => u.email === staff.email);
        if (user) {
            const { error } = await admin.auth.admin.updateUserById(user.id, { password });
            if (error) throw error;
        } else {
            const { data, error } = await admin.auth.admin.createUser({ email: staff.email, password, email_confirm: true });
            if (error) throw error;
            user = data.user;
        }
        const { error } = await admin.from('staff').upsert({ id: user.id, ...staff }, { onConflict: 'id' });
        if (error) throw error;
        console.log(`ok  ${staff.role.padEnd(5)} ${staff.email}`);
    }
    console.log(`Demo staff ready. Log in with the emails above and the password in ${ENV_FILE}.`);
}

main().catch(err => {
    console.error(err.message ?? err);
    process.exit(1);
});

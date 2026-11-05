export interface Activity {
    label: string;
    path: string;
    error?: string;
}

export interface ActivityRow {
    at: number;
    label: string;
    path: string;
    error: string | null;
}

const LABELS: Record<string, string> = {
    upload: 'Envoyé',
    'upload new version': 'Envoyé (nouvelle version)',
    download: 'Reçu',
    'download new version': 'Reçu (nouvelle version)',
    trash: 'Mis à la corbeille',
    quarantine: 'Mis en quarantaine',
    'conflict copy': 'Conflit : copie créée',
};

/** Journal lines read "<direction>  <operation>  <path>": the window shows them in plain words. */
export function describeActivity(line: string, error?: string): Activity {
    const [direction = '', op = '', ...rest] = line.split(/\s{2,}/);
    const toDrive = direction === 'local→drive';
    let label = LABELS[op] ?? op;
    if (op === 'move') label = toDrive ? 'Déplacé sur le Drive' : 'Déplacé ici';
    if (op === 'mkdir') label = toDrive ? 'Dossier créé sur le Drive' : 'Dossier créé ici';
    const path = rest.join('  ');
    return error ? { label: `Erreur : ${label}`, path, error } : { label, path };
}

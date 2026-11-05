import type { BaseRec, Entry, Snapshot } from './types';

/** Lecture d'un fichier local à envoyer. L'empreinte réelle est vérifiée pendant la lecture. */
/** Le nom visé est occupé : se règle à la passe suivante, sans gravité. */
export class PathBusy extends Error {}

export interface Source {
    size: number;
    mtime: number;
}

export interface LocalFs {
    /** Échoue si la racine est absente ou sans marqueur. */
    assertRootSafe(): Promise<void>;
    /** `known` permet de réutiliser les empreintes des fichiers inchangés. */
    scan(known: Map<string, BaseRec>): Promise<Snapshot>;
    mkdir(path: string): Promise<Entry>;
    /** Renomme sans jamais écraser : échoue si la destination existe. */
    move(from: string, to: string): Promise<void>;
    /** Vrai si le fichier ou dossier correspond encore à ce qui a été scanné. */
    isUnchanged(path: string, entry: Entry): Promise<boolean>;
    /** Déplace vers la quarantaine, sans rien détruire. */
    quarantine(path: string): Promise<void>;
    /** Prépare l'envoi d'un fichier. */
    openSource(path: string): Promise<Source>;
    /** Écrit via un temporaire puis renomme ; échoue si la destination existe. */
    writeFile(
        path: string,
        expectedHash: string | undefined,
        mtime: number,
        fill: (tmpPath: string) => Promise<void>,
        /** Appelé une fois le contenu complet et vérifié, juste avant de le mettre en place. */
        beforeInstall?: () => Promise<void>,
    ): Promise<Entry>;
}

/** Volontairement sans suppression définitive ni vidage de corbeille. */
export interface RemoteFs {
    snapshot(): Promise<Snapshot>;
    mkdir(parentId: string, name: string): Promise<Entry>;
    move(id: string, newParentId: string, newName: string): Promise<Entry>;
    upload(parentId: string, name: string, localPath: string, source: Source, expectedHash: string | undefined): Promise<Entry>;
    uploadRevision(id: string, localPath: string, source: Source, expectedHash: string | undefined): Promise<Entry>;
    download(id: string, tmpPath: string): Promise<void>;
    trash(id: string): Promise<void>;
}

export interface Store {
    all(): BaseRec[];
    put(rec: BaseRec): void;
    remove(key: string): void;
}

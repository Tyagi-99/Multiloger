/** Backups page: pick a profile, manage its encrypted backups. */

import { useCallback, useEffect, useState } from 'react';
import { messageOf } from '../api.js';
import type { ApiClient } from '../api.js';
import type { ProfileDetail } from '../types.js';
import { BackupList } from '../components/BackupList.js';
import { EmptyState, ErrorBanner, inputClass } from '../ui.js';

export function BackupsPage({
  client,
  eventCount,
}: {
  client: ApiClient;
  eventCount: number;
}): React.JSX.Element {
  const [profiles, setProfiles] = useState<ProfileDetail[]>([]);
  const [selected, setSelected] = useState<string>('');
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const res = await client.listProfiles();
      setProfiles(res.profiles);
      setSelected((current) => {
        if (current && res.profiles.some((p) => p.id === current)) {
          return current;
        }
        return res.profiles[0]?.id ?? '';
      });
    } catch (e) {
      setError(messageOf(e));
    }
  }, [client]);

  useEffect(() => {
    void refresh();
  }, [refresh, eventCount]);

  const selectedProfile = profiles.find((p) => p.id === selected) ?? null;

  return (
    <div>
      <div className="mb-4 flex items-center justify-between">
        <h1 className="text-xl font-semibold">Backups</h1>
        <select
          className={`${inputClass} w-64`}
          value={selected}
          onChange={(e) => { setSelected(e.target.value); }}
          aria-label="Select profile"
        >
          {profiles.map((p) => (
            <option key={p.id} value={p.id}>{p.name}</option>
          ))}
        </select>
      </div>
      {error && <ErrorBanner message={error} onDismiss={() => { setError(null); }} />}
      {!selectedProfile ? (
        <EmptyState message="No profiles yet." />
      ) : (
        <BackupList
          key={selectedProfile.id}
          client={client}
          profileId={selectedProfile.id}
          profileName={selectedProfile.name}
          onChanged={() => undefined}
        />
      )}
      <p className="mt-4 text-xs text-zinc-600">
        Backups are AES-256-GCM encrypted. Verification decrypts the blob, checks the
        authentication tag and the SHA-256 of the plaintext tarball.
      </p>
    </div>
  );
}

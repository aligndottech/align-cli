import type { PersonalImportItem } from '../personal-import.js';

interface ZoomRecordingFile {
  file_type: string;
  download_url: string;
  status: string;
}

interface ZoomMeeting {
  id: string | number;
  uuid: string;
  topic: string;
  start_time: string;
  host_email?: string;
  recording_files?: ZoomRecordingFile[];
}

function parseWebVtt(vtt: string): string {
  return vtt
    .split('\n')
    .filter(line =>
      line.trim() !== '' &&
      line.trim() !== 'WEBVTT' &&
      !/^\d+$/.test(line.trim()) &&
      !line.includes(' --> '),
    )
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function encodeMeetingUuid(uuid: string): string {
  const encoded = encodeURIComponent(uuid);
  return uuid.includes('//') ? encodeURIComponent(encoded) : encoded;
}

async function zoomGet<T>(path: string, token: string): Promise<T> {
  const res = await fetch(`https://api.zoom.us/v2${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({})) as { message?: string };
    throw new Error(`Zoom API error ${res.status}: ${err.message ?? 'unknown'}`);
  }
  return res.json() as Promise<T>;
}

export async function fetchZoomItems(opts: {
  token: string;
  limit?: number;
  uuid?: string;
}): Promise<PersonalImportItem[]> {
  const limit = opts.limit ?? 30;
  const path = opts.uuid
    ? `/meetings/${encodeMeetingUuid(opts.uuid)}/recordings`
    : `/users/me/recordings?page_size=30`;

  const data = await zoomGet<{ meetings?: ZoomMeeting[] }>(path, opts.token);
  const meetings = data.meetings ?? [];
  const items: PersonalImportItem[] = [];

  for (const meeting of meetings) {
    if (items.length >= limit) break;
    const vttFile = (meeting.recording_files ?? []).find(
      f => f.file_type === 'TRANSCRIPT' && f.status === 'completed',
    );
    if (!vttFile) continue;

    try {
      const vttRes = await fetch(`${vttFile.download_url}?access_token=${opts.token}`);
      if (!vttRes.ok) continue;
      const vttText = await vttRes.text();
      const transcript = parseWebVtt(vttText);
      if (!transcript) continue;

      const date = meeting.start_time.slice(0, 10);
      // Who to talk to (ALI-119): the meeting host.
      const host = meeting.host_email
        ? { name: meeting.host_email.split('@')[0], email: meeting.host_email }
        : undefined;
      items.push({
        source_url: `https://zoom.us/recording/${encodeMeetingUuid(meeting.uuid)}`,
        platform: 'zoom',
        raw_text: `[${meeting.topic} - ${date}]\n${transcript}`.slice(0, 4000),
        title: `${meeting.topic} (${date})`.slice(0, 80),
        ...(host ? { author: host } : {}),
      });
    } catch { /* skip recordings with inaccessible transcripts */ }
  }

  return items;
}

export type EnvName = 'local' | 'preview' | 'prod';

export const CONNECTOR_PORTS: Record<string, number> = {
  slack: 8081,
  confluence: 8082,
  jira: 8083,
  teams: 8084,
  github: 8085,
  zoom: 8090,
  'align-mcp': 8088,
};

export const SLACK_REQUIRED_SCOPES = [
  'channels:history',
  'channels:read',
  'chat:write',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'mpim:history',
  'reactions:read',
  'team:read',
  'users:read',
  'users:read.email',
  'app_mentions:read',
];

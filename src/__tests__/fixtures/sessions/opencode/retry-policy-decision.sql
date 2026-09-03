-- ALI-808 fixture: one real opencode session (opencode-ai 1.18.27), captured 2026-09-03.
-- Schema trimmed to the tables the reader adapter needs: project, session, message, part.
-- Content is real (a live `opencode run` against a throwaway repo); only the scratch
-- directory path was replaced with a placeholder.

CREATE TABLE project (
  id text PRIMARY KEY,
  name text,
  worktree text NOT NULL
);
CREATE TABLE session (
  id text PRIMARY KEY,
  project_id text NOT NULL,
  directory text NOT NULL,
  title text NOT NULL,
  version text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL
);
CREATE TABLE message (
  id text PRIMARY KEY,
  session_id text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  data text NOT NULL
);
CREATE TABLE part (
  id text PRIMARY KEY,
  message_id text NOT NULL,
  session_id text NOT NULL,
  time_created integer NOT NULL,
  time_updated integer NOT NULL,
  data text NOT NULL
);

INSERT INTO project (id, name, worktree) VALUES ('a4b102e94d94d71b6984bce494bfe442f576efc8', NULL, '/home/user/webhook-service');
INSERT INTO session (id, project_id, directory, title, version, time_created, time_updated) VALUES ('ses_f98790161ffeMW7hbl2WkjJUPP', 'a4b102e94d94d71b6984bce494bfe442f576efc8', '/home/user/webhook-service', 'Webhook retry count decision for failed deliveries', '1.18.27', 1788443295391, 1788443300765);
INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_06786fecc001wLuFAd0FlUM6f4', 'ses_f98790161ffeMW7hbl2WkjJUPP', 1788443295436, 1788443298543, '{"role":"user","time":{"created":1788443295436},"agent":"build","model":{"providerID":"openai","modelID":"gpt-5.6-sol"},"summary":{"diffs":[]}}');
INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_067870022001V5K7mCP2kDx95t', 'ses_f98790161ffeMW7hbl2WkjJUPP', 1788443295778, 1788443298506, '{"parentID":"msg_06786fecc001wLuFAd0FlUM6f4","role":"assistant","mode":"build","agent":"build","path":{"cwd":"/home/user/webhook-service","root":"/home/user/webhook-service"},"cost":0.031817,"tokens":{"total":6115,"input":3,"output":75,"reasoning":8,"cache":{"write":6029,"read":0}},"modelID":"gpt-5.6-sol","providerID":"openai","time":{"created":1788443295778,"completed":1788443298505},"finish":"tool-calls"}');
INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('msg_067870acb00123bWEMNWF0qgD6', 'ses_f98790161ffeMW7hbl2WkjJUPP', 1788443298507, 1788443300750, '{"parentID":"msg_06786fecc001wLuFAd0FlUM6f4","role":"assistant","mode":"build","agent":"build","path":{"cwd":"/home/user/webhook-service","root":"/home/user/webhook-service"},"cost":0.0038186,"tokens":{"total":6254,"input":3,"output":19,"reasoning":0,"cache":{"write":203,"read":6029}},"modelID":"gpt-5.6-sol","providerID":"openai","time":{"created":1788443298507,"completed":1788443300749},"finish":"stop"}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_06786fed20013gGQd3A13WkuNC', 'msg_06786fecc001wLuFAd0FlUM6f4', 'ses_f98790161ffeMW7hbl2WkjJUPP', 1788443295767, 1788443295770, '{"type":"text","text":"\"Read NOTES.md. Decide the retry count (pick 3 or 5) for failed webhook deliveries and state it as a one-line decision with rationale. Do not ask questions.\""}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_0678707720013YJdlv0xs4tbsK', 'msg_067870022001V5K7mCP2kDx95t', 'ses_f98790161ffeMW7hbl2WkjJUPP', 1788443297650, 1788443297652, '{"snapshot":"d293bb271fe096bc1d0957faba8d798dffc50b7d","type":"step-start"}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_067870775001ySpVC42ctAHTDZ', 'msg_067870022001V5K7mCP2kDx95t', 'ses_f98790161ffeMW7hbl2WkjJUPP', 1788443297653, 1788443297923, '{"type":"reasoning","text":"","time":{"start":1788443297653,"end":1788443297922},"metadata":{"openai":{"itemId":"rs_0df8e56167809e2e016a997aa197e887d2bb45b151c0014def","reasoningEncryptedContent":"gAAAAABqmXqh0LKj0Mcb1kIqnQvMGSN5yqSHs-eg1Bg1IPs3s-keufQN5jTd084m_lKUlg_NCdHuSM16hWdqA2kgoj3g9q4PDygeMmBHgxBSk_rO3654yZ4q6rCPEmA3VbTcLNX80WlALjskFrXFxTyMCnP7JDxTe2gZbaWBD1dnx1tvcEg_2icClwE6Rjp800rFHMIbR9nuFKl5NwJ8T0mEoeMn4mcAmM_cIeSvJYj2acyOxvMfqPy4SBUYk2cTTvfvgm1Yd6d7vatlhXSgkOSxBh0gA7cHKOTnqfR42acjh91Q95O5HxAq2xuHfcvu1TAraZXZ4S4KKzyF9YXIOvLP6ooPjIN1_3ieNWzgaKOMFtd0PWGVQcfuXUb-75_jVS0FmsXhNu1RAZzB9BcNSb56qDankCXEUkL6W2WEjaO5W3J7ZG6FsUg63BHIE6tMoNL5KYRaPb-1sMkxdLYUXcvQ_PQ0wm_IKcY7OEUxOmtyptAw3epcY7K4Za7twZt85A4cXHrALDkPt5SgVEOo7gEZKAvX_xZvQ29emAqaBvD2CQ9u0m2wH0J8q43SVksPO8vqoy8cj8-8ylZSD18GmSuRxwqslsTFh1BwbSMGdah5UtYuw7r9KUwqghcLTNVzx-IPmdXcry64ynFQyltOTBgFkiQgXf7zF2Pz3ezcPLTKDr0Bt-jFOULWUGqXnsvfFNAcNm8HCaU0BUI-Xo9wiDg2DERvAPM-bXBoyPMVrOFBCU6XyE9d2lr0MRVzKAU8toyOFnpccv8YjJ4ExNSVHi7gN24Gxuv7jXLeYNupTND8i0JyZh1utjiu4d9AiSxSa-vlt1_Uwg8kBRMw2h4XuJdeLGLhII9eNBY-qhpZ5PeYUoB1jMdzTvWxkZcjdfBf-bFFBSepsMlxo4ztjOb3CibqXvG8cEJJNG_aGkVAvYgMdFtdKImvwBCu8mSEjmHkMEhxUbN05_SB8TpFbLDr2pWFU14BIh2Mm8iXsBukneCvCFZUM-YVF4qno50sc6KwnvbGqjhqXm7mDsyYU8MplQxP0LAsibgU0TfRc2LAIiKIa15Tj0J1ViAWig5jAY8eJYJydTIgcXM2BRl6HNhsNSEMTfVVc1JB0UQjju6nAbjfo2I6qIIujvj_fLDoyxcPFoNdTMUtlnfGMF6LT9jiNV3W5H6TZbha9kORPNzJpObt1kXdrWSSZ90="}}}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_067870886001q6guHlwqceV3Kj', 'msg_067870022001V5K7mCP2kDx95t', 'ses_f98790161ffeMW7hbl2WkjJUPP', 1788443297926, 1788443298456, '{"type":"tool","tool":"read","callID":"call_XghabRkqyRobihFoqeHD0tdv","state":{"status":"completed","input":{"filePath":"/home/user/webhook-service/NOTES.md"},"output":"<path>/home/user/webhook-service/NOTES.md</path>\n<type>file</type>\n<content>\n1: # Retry policy notes\n2: We need to decide how many times to retry a failed webhook delivery before giving up.\n\n(End of file - total 2 lines)\n</content>","metadata":{"preview":"# Retry policy notes\nWe need to decide how many times to retry a failed webhook delivery before giving up.","truncated":false,"loaded":[],"display":{"type":"file","path":"/home/user/webhook-service/NOTES.md","text":"# Retry policy notes\nWe need to decide how many times to retry a failed webhook delivery before giving up.","lineStart":1,"lineEnd":2,"totalLines":2,"truncated":false}},"title":"NOTES.md","time":{"start":1788443298433,"end":1788443298455}},"metadata":{"openai":{"itemId":"fc_0df8e56167809e2e016a997aa1d3e087d299d0c345eb933628"}}}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_067870ab700186lH6vSR9M2RGr', 'msg_067870022001V5K7mCP2kDx95t', 'ses_f98790161ffeMW7hbl2WkjJUPP', 1788443298488, 1788443298489, '{"reason":"tool-calls","snapshot":"d293bb271fe096bc1d0957faba8d798dffc50b7d","type":"step-finish","tokens":{"total":6115,"input":3,"output":75,"reasoning":8,"cache":{"write":6029,"read":0}},"cost":0.031817}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_0678711a6001v8Utmt4ZX19Imi', 'msg_067870acb00123bWEMNWF0qgD6', 'ses_f98790161ffeMW7hbl2WkjJUPP', 1788443300263, 1788443300264, '{"snapshot":"d293bb271fe096bc1d0957faba8d798dffc50b7d","type":"step-start"}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_0678711a9001Gek71H5PzjKM8N', 'msg_067870acb00123bWEMNWF0qgD6', 'ses_f98790161ffeMW7hbl2WkjJUPP', 1788443300265, 1788443300668, '{"type":"text","text":"Use 5 retries to better tolerate transient webhook delivery failures before giving up.","time":{"start":1788443300265,"end":1788443300667},"metadata":{"openai":{"itemId":"msg_03dedaf27293548d016a997aa4364487d2b474dcd1bc993683","phase":"final_answer"}}}');
INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES ('prt_0678713790012vOlTNIoymzUu5', 'msg_067870acb00123bWEMNWF0qgD6', 'ses_f98790161ffeMW7hbl2WkjJUPP', 1788443300729, 1788443300731, '{"reason":"stop","snapshot":"d293bb271fe096bc1d0957faba8d798dffc50b7d","type":"step-finish","tokens":{"total":6254,"input":3,"output":19,"reasoning":0,"cache":{"write":203,"read":6029}},"cost":0.0038186}');

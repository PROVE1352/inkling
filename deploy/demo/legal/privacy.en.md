# Inkling Demo Service Privacy Policy

Effective date: {{EFFECTIVE_DATE}}

## 1. About this policy

This policy explains how {{OPERATOR_NAME}} (the "operator") handles personal information in the Inkling demo service at {{SERVICE_URL}} (the "service"). Inkling is a note app for teams. The service is a demo server for people who want to try it. The operator is an individual and does not make money from the service. There are no ads. The operator does not sell personal information or hand it to other companies. The service is for people who live in the Republic of Korea or the United States.

The service collects only the following: the user ID you choose, your nickname, your password (stored only as a hash), the content you write, automatic records such as the IP address and time of access, consent records, the cookie that keeps you signed in, data from optional features you turn on (two-step verification, AI tool connections, API tokens), and, if you email the operator a request, the address and content of that email. The service does not take your real name or contact details such as an email address or phone number, and it does not send email or text messages. Section 2 lists everything in detail.

The operator processes only the personal information needed to run the service. Your notes are not used to train AI models and are not shown to anyone you did not share them with.

## 2. Personal information we process

Everything below is needed to provide the service under the Terms of Service. The legal basis is the conclusion and performance of that contract. Access logs and security records are also used to keep the service secure. The signup screen shows a summary of this and asks you to confirm it. Items marked "optional" are processed only if you turn that feature on. You can use the service without them.

| Item | When we collect it | Required/optional |
|---|---|---|
| User ID (a sign-in string you choose), nickname (the name others see), password (stored only as a one-way hash) | At signup | Required |
| Signup time (used to work out the automatic deletion date), interface language | At signup, when you change settings | Required |
| Sign-in state (session) | When you sign in | Required |
| Content you create: pages, note text, comments, attached files, handwriting, favorites, status message, page version history and change history | When you use the service | Required (this is the service) |
| Workspace memberships and roles, notifications and notification settings, workspace admin log (who did which admin action) | When you use the service | Required |
| Access logs: IP address, time, requested address (with secret values masked), request method | Every time you connect | Required |
| Security records: IP addresses with repeated sign-in or verification failures, and blocks; the IP address of signup requests (to limit signups from the same IP) | When sign-in or verification fails, at signup | Required |
| Two-step verification data (authenticator secret stored encrypted, recovery codes stored only as hashes) | When you turn on two-step verification | Optional |
| AI tool connections: name of the connected tool, permissions and scope you allowed, time of last use | When you connect an AI tool | Optional |
| Personal API tokens: token name, permissions, time and IP address of last use | When you create an API token | Optional |
| Records of your agreement to the Terms and confirmation of this policy: the items you agreed to, the document version (a 12-character identifier made from the documents' text), time, IP address | At signup, and when a changed document needs confirming again | Required |
| The contact details (the address of your email) and content of a request you send the operator by email | When you send a request by email | Optional |

Do not put personal information such as your real name, email address or phone number in your user ID or nickname. The service does not take contact details, so it never contacts you by email, text or phone. There are no verification, notification, invitation or deletion-warning emails.

We do not collect government ID numbers, sensitive data such as health information, or payment information. If you write other people's personal information into your notes, it is stored as part of your content.

## 3. Why we process it

- Signing up, signing in and managing your account
- Providing the service: writing notes, sharing, working together, notifications
- Letting an AI tool you connect read and write your notes
- Protecting accounts: two-step verification
- Security and stable operation: blocking unauthorized access, preventing automated signups (limiting signups from the same IP), preventing abuse, finding the cause of failures
- Showing when your account will be deleted, and announcing changes or shutdowns (in the app and on the sign-in screen)
- Answering your questions and requests about your rights

## 4. How long we keep it

When the period below ends or the purpose is met, we delete the information without delay.

| Item | Retention |
|---|---|
| Account data (user ID, nickname, password, signup time, language) | 14 days from signup, or until you delete your account, whichever comes first |
| Content you create | Until you delete it, at most 14 days from signup or until you delete your account, whichever comes first. Pages and workspaces in the trash are permanently deleted after 7 days. For what you wrote in shared workspaces, see section 5 |
| Page version history | The latest 10 per page, at most until the page is permanently deleted |
| Page change history | 30 days |
| Read notifications | 90 days |
| Workspace admin log | The period set in the workspace settings (90 days by default) |
| Sign-in state (session) | Until you sign out, at most 30 days. Ends when the account is deleted |
| Two-step verification data | Until you turn it off or the account is deleted |
| AI tool connections, personal API tokens | Until you remove them, they expire, or the account is deleted |
| Access logs (IP address etc.) | Kept in the server's log files, which drop their oldest part once they pass a set size (3 files of 10 MB). So how long they last depends on traffic. They may outlast the account until then |
| Security records (failing IPs and blocks, signup request IPs) | Blocks: 30 days after the block ends. Signup request IPs: 30 days from when they are recorded. They may outlast the account by up to that long |
| Agreement and confirmation records | Deleted together with the account |
| Contact details and content of requests received by email | 7 days after the request is handled |
| Backup copies | Up to 7 days from the backup. So data can stay in backup copies for up to 7 days after the account is deleted, at most 21 days from signup |

When your account is deleted, by you or automatically 14 days after signup, we delete that account's data right away, even if a period above has not ended. Access logs and security records stay only in a form not linked to the account and are deleted when their period ends. Data inside backup copies is deleted when those backups expire, at most 7 days later.

## 5. How we delete it

- **Deleting your account:** When you ask to delete your account and confirm once more, we delete the account and your private notes and files right away, with no grace period. The operator does not restore deleted accounts or material on request. Deleted data stays in backup copies for up to 7 days and is then removed.
- **Shared workspaces:** Pages, comments and files you wrote in a workspace you share with other people stay in that workspace, and only your name as the author is removed. Your name is also removed from the workspace admin log. Mentions of you in what other members wrote, and names other members typed themselves, are their writing and stay. The admin log and the server's internal job records (the queue that processes notifications and the change history) may keep an internal ID number without a name (job records are deleted once processed and their retention ends). If you are the only owner of a workspace that has other members and you delete your account, ownership passes automatically to the longest-standing member with the admin role, or else to the longest-standing member, who is told in the app.
- **Workspaces with no members left:** When the last member deletes their account or leaves, the workspace is deleted right away together with everything in it.
- **Automatic deletion 14 days after signup:** Every demo account is deleted 14 days after signup, whether or not it is used. It is handled the same way as deleting your account (the three items above). If you delete your account earlier, it is deleted at that moment. The deletion date is set at signup. We explain it on the signup screen and always show it in the app once you sign in. We do not send email about it. To try the service again, sign up again. The user ID is deleted with the account, so the same ID can be used again after the account is deleted.
- **Expired data:** The server deletes data automatically when the periods in section 4 end.
- **Method:** We delete database records and stored files so they cannot be recovered. Backup copies are deleted as a whole when they expire. We do not process personal information on paper.
- **When the service ends:** If the demo service is shut down, the operator deletes the service's database, files and backup copies without delay, including backups whose period has not ended. If the service stops suddenly because of a server failure or a decision by the cloud provider, the operator deletes the data as soon as the operator can reach the server again. If the operator can never reach it again, the data is deleted under the cloud provider's policies.

## 6. Sharing with third parties

We do not provide your personal information to third parties. We do not sell it and do not use it for ads. If a law enforcement agency or similar body asks for it through a procedure set by law, we comply only as far as the law requires.

Information that others see because of something you did is not third-party sharing. For example, members you invite to a workspace can see your nickname, your user ID and what you write in that workspace. For AI tools you connect, see section 9.

## 7. Service providers (processors)

We use the following provider to run the service.

| Provider | What they do |
|---|---|
| Oracle (Oracle Cloud Infrastructure) | Provides the servers and storage the service runs on (cloud hosting) |

The provider only rents out servers and storage. It is not engaged to look at your data or use it for anything else. If the provider changes, we will update this policy and tell you.

The service does not send email, so no email provider is engaged.

## 8. Transfer outside Korea

The service's server is in Japan. So the personal information of users who sign up from Korea is also stored on a server in Japan. On the signup screen we show the details below and ask for your separate consent to this transfer. If the details change, we will tell you and ask for your consent again.

| | Details |
|---|---|
| Recipient | Oracle (Oracle Cloud Infrastructure) |
| Contact | The inquiry channel on Oracle's privacy page (https://www.oracle.com/legal/privacy/) |
| Country | Japan (Oracle Cloud Tokyo region) |
| When and how | Whenever you sign up and use the service, stored on the server over an encrypted internet connection |
| Items | All items in section 2 |
| Recipient's purpose | Providing servers and storage for the service |
| Recipient's retention | Same as section 4. Deleted when the service contract ends |
| How to refuse, and what happens | You may refuse consent to the transfer at signup. If you refuse, or delete your account, nothing is transferred. The service runs only on this server, so you cannot use it if you do not want your data stored outside Korea |

## 9. AI tools you connect and outside features

- **AI tool connections:** You can connect your own AI tool (for example an AI assistant such as Claude) to the service. Once connected, the tool can read and write your notes within the scope you allow. What reaches the AI tool is handled under the privacy policy and terms of the company that provides that tool. This is a connection you set up, not information the operator provides. You can remove a connection in Settings at any time.
- **Outside images and videos:** If you put an image or video from another site on a page, the browser of anyone who opens that page loads it directly from that site. That site can receive the visitor's IP address and similar data, and its own policies apply.
- **Features turned off in the demo:** Features that send content outside the service or fetch it from outside, such as public links, public forms, webhooks, the Slack integration, link previews, web push notifications, framing other sites inside a page, article import and semantic search, are not used in the demo service.

## 10. Your rights and how to use them

You can ask us at any time to:

- Access: tell you what information we hold about you
- Correct or delete: fix wrong information or delete it
- Stop processing: stop processing your information
- Withdraw consent and delete your account

Requests should normally be made while signed in, using the features in the app. Change your nickname, password and language in Settings, delete or export your notes yourself, and delete your account in Settings. For anything the app cannot do, write to {{CONTACT_EMAIL}}. The service holds no contact details for you, so if you write by email we check that you own the account using your user ID and information only the account holder would know (for example a workspace name or the title of a page you made recently). Once confirmed, we act on the request or tell you why we cannot, within 10 days of receiving it. The contact details and content of your request email are deleted within 7 days after the request is handled. Because there is no contact detail to confirm who you are, the service does not offer password resets. If you forget your password, sign up again. Accounts are deleted automatically 14 days after signup.

You can also make a request through a representative (a legal guardian or someone you have authorized). Please include proof of their authority.

We may refuse part of a request where the law allows, for example when we must keep the information by law or when fulfilling it could harm someone else's rights. We will tell you why.

## 11. Children under 14

The service does not accept signups from anyone under 14. If we learn that someone under 14 has signed up, we delete the account and its data without delay. If you know of such a case, please tell us at {{CONTACT_EMAIL}}.

## 12. How we protect your information

- **Passwords:** Passwords are hashed with Argon2id. We do not store the password itself.
- **Sign-in data and tokens:** For sessions, API tokens and AI connection tokens, we store only a hash, not the value itself.
- **Encryption at rest:** Some secrets, such as two-step verification secrets, are encrypted with a server key before they are stored. Note text and attached files are stored in the database and file storage without encryption.
- **Encryption in transit:** The service is offered over HTTPS only, and the sign-in cookie is set to be sent only over HTTPS.
- **Access control:** Notes are visible only to members of the workspace and people you allow. Private pages are visible only to their author. AI tool connections and API tokens work only within the permissions and scope you set. Admin features work only from a browser sign-in.
- **Preventing unauthorized access:** IP addresses with repeated sign-in or verification failures are blocked for a while, and request rates and the number of signups from the same IP address are limited. Two-step verification is available.
- **Access logs:** The server logs requests (IP address, time, requested address), masking secret values in addresses first. Admin actions in a workspace are kept in the workspace admin log.
- **Breach notice:** If a personal data breach happens, we post a notice on the sign-in screen and in the app saying what was affected, when and how it happened, what you can do, what we are doing, and how to contact us. The service holds no contact details for you, so this notice is how we tell you.
- **Operator access:** As the server administrator, the operator can technically access the data. The operator does not open your notes except when needed to handle a failure, respond to a legal demand, or act on your request.

## 13. Cookies and similar technologies

The service does not use cookies or trackers for ads or analytics. It stores only what is needed for the service to work in your browser.

| Name | Type | Purpose | Kept for |
|---|---|---|---|
| inkling_sid | Cookie | Keeps you signed in | Until you sign out, at most 30 days |
| Entries starting with inkling: | Browser storage (localStorage) | Interface settings such as a collapsed sidebar or the last workspace you opened | Until you clear them |
| inkling-offline | Browser database (IndexedDB) | Copies of notes on this device so you can open them offline (on by default in the installed app; in a browser tab only if turned on in Settings) | Until you sign out or turn the setting off |

You can block cookies in your browser settings, but you cannot sign in without the sign-in cookie. Offline copies stay on the device unencrypted, so on a shared computer turn this feature off and sign out when you are done.

## 14. Privacy officer

The operator is the privacy officer. Send questions, complaints and requests about personal information to:

- Privacy officer: {{OPERATOR_NAME}}
- Email: {{CONTACT_EMAIL}}

## 15. Where else you can get help

For advice or remedies about a privacy violation in Korea, you can contact:

- Personal Information Dispute Mediation Committee: 1833-6972, www.kopico.go.kr
- Personal Information Infringement Report Center (Korea Internet & Security Agency): 118 (from Korea), privacy.kisa.or.kr
- Supreme Prosecutors' Office: 1301 (from Korea)
- Korean National Police Agency: 182 (from Korea)

## 16. Changes to this policy

If we change this policy, we post a notice in the app and on the sign-in screen at least 7 days before the change takes effect. We do not send email about it. For changes that matter to your rights, such as new items or new purposes, we post it at least 30 days before and ask you to confirm again at your next sign-in. We send earlier versions on request to {{CONTACT_EMAIL}}.

- Version: 1
- Effective date: {{EFFECTIVE_DATE}}

## 17. Additional information for users in the United States

- **Children under 13:** The service is not directed to children and does not knowingly collect personal information from children under 13. If we learn that we have, we delete it and the account. Parents can contact {{CONTACT_EMAIL}}.
- **No sale or sharing:** We do not sell personal information and do not share it for cross-context behavioral advertising. We do not use it for targeted ads.
- **Your requests:** You can ask to access, correct, delete or get a copy of your personal information by writing to {{CONTACT_EMAIL}}, or use the account and export features in the app. We will not treat you differently for making a request.
- **State privacy laws:** The demo service is run by an individual and earns no revenue. It probably does not meet the thresholds of state laws such as the California Consumer Privacy Act. Even so, we handle requests from residents of any state in the same way described here.

## 18. Who the service is for

The service is offered to people who live in the Republic of Korea or the United States. It is not offered to people who live in the European Economic Area (EEA), the United Kingdom or Switzerland, and they should not sign up. If we learn that someone living in those places has signed up, we delete the account and its data.

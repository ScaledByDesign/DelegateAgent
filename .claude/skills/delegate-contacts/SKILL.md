---
name: delegate-contacts
description: Access and manage Delegate CRM contacts — rich profiles with AI persona context (tonality, personality, aiContext, background), activity history, and Google Contacts sync.
---

# Delegate Contacts

Delegate maintains a rich CRM Contact model separate from the raw Google Contacts sync.
Use this skill to look up contact profiles, AI persona context, and activity — especially before drafting emails, scheduling meetings, or delegating tasks involving specific people.

Auth: `-H "Authorization: Bearer $DELEGATE_API_TOKEN"`
Base: `$DELEGATE_URL`

## Contact Fields

| Field | Type | Description |
|-------|------|-------------|
| `id` | string | Delegate contact ID |
| `name` | string | Full name |
| `email` | string | Primary email |
| `phone` | string | Primary phone |
| `company` | string | Organisation name |
| `jobTitle` | string | Job title |
| `department` | string | Department |
| `relationshipType` | string | `client`, `partner`, `vendor`, `lead`, `colleague`, `contact` |
| `projectTags` | string[] | Projects this contact is associated with |
| `tonality` | string | Preferred communication tone, e.g. `"formal"`, `"casual"`, `"use first name"` |
| `personality` | string | Personality traits and behavioural notes |
| `aiContext` | string | Free-text context the AI should know when communicating with this person |
| `background` | string | LinkedIn bio, career summary, or manual background notes |
| `socialProfiles` | object | `{ linkedin, twitter, github, instagram, website }` |
| `tags` | string[] | Custom tags |
| `notes` | string | Internal notes |

## Delegate Contacts API

### Search contacts
```bash
curl -s "$DELEGATE_URL/api/contacts?search=John+Smith" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" | jq '.data'
```

### List all contacts (paginated)
```bash
curl -s "$DELEGATE_URL/api/contacts?limit=50&offset=0" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" | jq '.data'
```

### Get contact by ID
```bash
curl -s "$DELEGATE_URL/api/contacts/<CONTACT_ID>" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" | jq '.'
```

### Look up by email
```bash
curl -s "$DELEGATE_URL/api/contacts/by-email?email=alice%40example.com" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" | jq '.'
```

### Look up by phone
```bash
curl -s "$DELEGATE_URL/api/contacts/by-phone?phone=%2B15551234567" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" | jq '.'
```

### Create contact
```bash
curl -s -X POST "$DELEGATE_URL/api/contacts" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Alice Chen",
    "email": "alice@example.com",
    "company": "Acme Corp",
    "jobTitle": "Product Manager",
    "relationshipType": "client",
    "tonality": "casual, use first name",
    "aiContext": "Alice prefers short async updates. She values data-driven arguments.",
    "projectTags": ["proj_abc123"]
  }' | jq '.'
```

### Update contact
```bash
curl -s -X PATCH "$DELEGATE_URL/api/contacts/<CONTACT_ID>" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "tonality": "formal",
    "aiContext": "Recently promoted to VP. Focus on strategic topics.",
    "notes": "Met at SaaS conference Jan 2026"
  }' | jq '.'
```

### Delete contact
```bash
curl -s -X DELETE "$DELEGATE_URL/api/contacts/<CONTACT_ID>" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN"
```

### Get contact activity (emails, meetings linked to this contact)
```bash
curl -s "$DELEGATE_URL/api/contacts/<CONTACT_ID>/activity" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" | jq '.'
```

## Google Contacts Integration Proxy

Use the integration proxy to search the user's synced Google Contacts (raw Google People API data, not the CRM model above):

```bash
# Search Google Contacts
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/google_contacts/search" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"query":"Alice Chen"}' | jq '.results'

# List Google Contacts
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/google_contacts/list" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"limit":50}' | jq '.connections'

# Get a single Google Contact by resource name
curl -s -X POST "$DELEGATE_URL/api/agent/integrations/google_contacts/get" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"resourceName":"people/c1234567890"}' | jq '.'
```

## When to Use Each Source

| Use Case | Source |
|----------|--------|
| Drafting email — need tone/style guidance | Delegate Contacts API (`aiContext`, `tonality`) |
| Check if a contact exists by email | `GET /api/contacts/by-email` |
| Create or update a CRM profile | `POST/PATCH /api/contacts` |
| Look up recent email/meeting history | `GET /api/contacts/<id>/activity` |
| Autocomplete a name from Google address book | Integration proxy `google_contacts/search` |
| Find a phone number or organisation | Either source — try Delegate first, fall back to Google |

## Workflow Example: Personalise an Email

```bash
# 1. Find the contact
CONTACT=$(curl -s "$DELEGATE_URL/api/contacts/by-email?email=alice%40example.com" \
  -H "Authorization: Bearer $DELEGATE_API_TOKEN")

# 2. Extract AI context
AI_CTX=$(echo $CONTACT | jq -r '.aiContext // "No context available"')
TONALITY=$(echo $CONTACT | jq -r '.tonality // "professional"')

# 3. Use context when composing the email
echo "Tone: $TONALITY"
echo "Context: $AI_CTX"
# → pass these into your email drafting prompt
```

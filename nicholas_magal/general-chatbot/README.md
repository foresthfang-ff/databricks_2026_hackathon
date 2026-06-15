# Facility Chatbot

Facility Chatbot is a Databricks AppKit application for asking natural-language questions about healthcare facilities in India. Every chat turn is grounded in Unity Catalog facility tables before the LLM responds; the app does not answer from general model knowledge alone.

The app uses AppKit Analytics to retrieve compact facility context from:

- `medallion_architecture.gold.gold_facility`
- `medallion_architecture.gold.gold_facility_contact`
- `medallion_architecture.gold.gold_facility_location`
- `medallion_architecture.gold.gold_facility_procedure`
- `medallion_architecture.gold.gold_facility_specialty`

The grounding query joins facility identity, location, contact, procedure, and specialty evidence by `facility_id`, ranks matching rows against the user question, and sends only the top compact results to the configured Databricks Model Serving endpoint. The assistant then cites facility names, relevant specialties or procedures, locations, contact details, and confidence/evidence signals when available.

This app is intended for exploratory facility lookup: finding hospitals by specialty, procedure, geography, or contact information, and summarizing what the available facility evidence supports. If no matching rows are found, the chatbot asks the user to refine the facility name, location, specialty, or procedure rather than inventing an answer.

Core implementation files:

- `client/src/App.tsx` for the chat experience
- `config/queries/facility_grounding.sql` for table grounding
- `server/server.ts` for AppKit Analytics and Serving plugins


export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[]

export type Database = {
  
  "graphql_public": {
          Tables: {
            [_ in never]: never
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "graphql":
{ Args: { "extensions"?: Json,"operationName"?: string,"query"?: string,"variables"?: Json }; Returns: Json
                           }
          }
          Enums: {
            [_ in never]: never
          }
          CompositeTypes: {
            [_ in never]: never
          }
        },"public": {
          Tables: {
            "agent_events": {
                  Row: {
                    "actor_user_id": string | null,"agent_id": string | null,"approval_id": string | null,"causation_id": string | null,"correlation_id": string | null,"created_at": string,"event_type": string,"handoff_id": string | null,"id": string,"organisation_id": string,"payload": NonNullable<Json>,"severity": Database["public"]['Enums']["event_severity"],"summary": string,"task_id": string | null,"tender_id": string | null,"workflow_run_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_user_id"?: string | null,"agent_id"?: string | null,"approval_id"?: string | null,"causation_id"?: string | null,"correlation_id"?: string | null,"created_at"?: string,"event_type": string,"handoff_id"?: string | null,"id"?: string,"organisation_id": string,"payload"?: NonNullable<Json>,"severity"?: Database["public"]['Enums']["event_severity"],"summary": string,"task_id"?: string | null,"tender_id"?: string | null,"workflow_run_id"?: string | null
                  }
                  Update: {
                    "actor_user_id"?: string | null,"agent_id"?: string | null,"approval_id"?: string | null,"causation_id"?: string | null,"correlation_id"?: string | null,"created_at"?: string,"event_type"?: string,"handoff_id"?: string | null,"id"?: string,"organisation_id"?: string,"payload"?: NonNullable<Json>,"severity"?: Database["public"]['Enums']["event_severity"],"summary"?: string,"task_id"?: string | null,"tender_id"?: string | null,"workflow_run_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "agent_events_agent_id_fkey"
      columns: ["agent_id"]
isOneToOne: false
      referencedRelation: "agents"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "agent_events_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"agent_permissions": {
                  Row: {
                    "access": Database["public"]['Enums']["access_level"],"agent_id": string,"created_at": string,"data_category": Database["public"]['Enums']["data_category"],"organisation_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "access"?: Database["public"]['Enums']["access_level"],"agent_id": string,"created_at"?: string,"data_category": Database["public"]['Enums']["data_category"],"organisation_id": string
                  }
                  Update: {
                    "access"?: Database["public"]['Enums']["access_level"],"agent_id"?: string,"created_at"?: string,"data_category"?: Database["public"]['Enums']["data_category"],"organisation_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "agent_permissions_agent_id_fkey"
      columns: ["agent_id"]
isOneToOne: false
      referencedRelation: "agents"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "agent_permissions_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"agent_status_transitions": {
                  Row: {
                    "agent_id": string,"created_at": string,"from_status": Database["public"]['Enums']["agent_status"] | null,"id": number,"organisation_id": string,"reason": string | null,"task_id": string | null,"to_status": Database["public"]['Enums']["agent_status"]
                  }
                  ComputedFields: never
                  Insert: {
                    "agent_id": string,"created_at"?: string,"from_status"?: Database["public"]['Enums']["agent_status"] | null,"id"?: never,"organisation_id": string,"reason"?: string | null,"task_id"?: string | null,"to_status": Database["public"]['Enums']["agent_status"]
                  }
                  Update: {
                    "agent_id"?: string,"created_at"?: string,"from_status"?: Database["public"]['Enums']["agent_status"] | null,"id"?: never,"organisation_id"?: string,"reason"?: string | null,"task_id"?: string | null,"to_status"?: Database["public"]['Enums']["agent_status"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "agent_status_transitions_agent_id_fkey"
      columns: ["agent_id"]
isOneToOne: false
      referencedRelation: "agents"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "agent_status_transitions_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"agents": {
                  Row: {
                    "allowed_tools": (string)[],"created_at": string,"current_task_id": string | null,"current_tender_id": string | null,"daily_budget_usd": number | null,"department_id": string,"description": string,"display_name": string,"escalation_policy": NonNullable<Json>,"id": string,"last_action": string | null,"last_action_at": string | null,"max_concurrent_tasks": number,"model_override": string | null,"model_tier": Database["public"]['Enums']["cost_tier"],"next_expected_action": string | null,"organisation_id": string,"responsibilities": (string)[],"role_title": string,"slug": string,"status": Database["public"]['Enums']["agent_status"],"status_changed_at": string,"status_reason": string | null,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "allowed_tools"?: (string)[],"created_at"?: string,"current_task_id"?: string | null,"current_tender_id"?: string | null,"daily_budget_usd"?: number | null,"department_id": string,"description"?: string,"display_name": string,"escalation_policy"?: NonNullable<Json>,"id"?: string,"last_action"?: string | null,"last_action_at"?: string | null,"max_concurrent_tasks"?: number,"model_override"?: string | null,"model_tier"?: Database["public"]['Enums']["cost_tier"],"next_expected_action"?: string | null,"organisation_id": string,"responsibilities"?: (string)[],"role_title": string,"slug": string,"status"?: Database["public"]['Enums']["agent_status"],"status_changed_at"?: string,"status_reason"?: string | null,"updated_at"?: string
                  }
                  Update: {
                    "allowed_tools"?: (string)[],"created_at"?: string,"current_task_id"?: string | null,"current_tender_id"?: string | null,"daily_budget_usd"?: number | null,"department_id"?: string,"description"?: string,"display_name"?: string,"escalation_policy"?: NonNullable<Json>,"id"?: string,"last_action"?: string | null,"last_action_at"?: string | null,"max_concurrent_tasks"?: number,"model_override"?: string | null,"model_tier"?: Database["public"]['Enums']["cost_tier"],"next_expected_action"?: string | null,"organisation_id"?: string,"responsibilities"?: (string)[],"role_title"?: string,"slug"?: string,"status"?: Database["public"]['Enums']["agent_status"],"status_changed_at"?: string,"status_reason"?: string | null,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "agents_current_task_fk"
      columns: ["current_task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "agents_current_tender_fk"
      columns: ["current_tender_id"]
isOneToOne: false
      referencedRelation: "tenders"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "agents_department_id_fkey"
      columns: ["department_id"]
isOneToOne: false
      referencedRelation: "departments"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "agents_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"approvals": {
                  Row: {
                    "approved_at": string | null,"comments": string | null,"decided_by": string | null,"expires_at": string | null,"id": string,"organisation_id": string,"payload": NonNullable<Json>,"rejected_at": string | null,"requested_at": string,"requested_by_agent_id": string | null,"risk_level": Database["public"]['Enums']["risk_level"],"status": Database["public"]['Enums']["approval_status"],"summary": string,"task_id": string | null,"tender_id": string | null,"type": Database["public"]['Enums']["approval_type"],"workflow_run_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "approved_at"?: string | null,"comments"?: string | null,"decided_by"?: string | null,"expires_at"?: string | null,"id"?: string,"organisation_id": string,"payload"?: NonNullable<Json>,"rejected_at"?: string | null,"requested_at"?: string,"requested_by_agent_id"?: string | null,"risk_level"?: Database["public"]['Enums']["risk_level"],"status"?: Database["public"]['Enums']["approval_status"],"summary": string,"task_id"?: string | null,"tender_id"?: string | null,"type": Database["public"]['Enums']["approval_type"],"workflow_run_id"?: string | null
                  }
                  Update: {
                    "approved_at"?: string | null,"comments"?: string | null,"decided_by"?: string | null,"expires_at"?: string | null,"id"?: string,"organisation_id"?: string,"payload"?: NonNullable<Json>,"rejected_at"?: string | null,"requested_at"?: string,"requested_by_agent_id"?: string | null,"risk_level"?: Database["public"]['Enums']["risk_level"],"status"?: Database["public"]['Enums']["approval_status"],"summary"?: string,"task_id"?: string | null,"tender_id"?: string | null,"type"?: Database["public"]['Enums']["approval_type"],"workflow_run_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "approvals_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "approvals_organisation_id_requested_by_agent_id_fkey"
      columns: ["organisation_id","requested_by_agent_id"]
isOneToOne: false
      referencedRelation: "agents"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "approvals_organisation_id_tender_id_fkey"
      columns: ["organisation_id","tender_id"]
isOneToOne: false
      referencedRelation: "tenders"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "approvals_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "approvals_workflow_run_id_fkey"
      columns: ["workflow_run_id"]
isOneToOne: false
      referencedRelation: "workflow_runs"
      referencedColumns: ["id"]
    }
                  ]
                },"audit_logs": {
                  Row: {
                    "action": string,"actor_agent_id": string | null,"actor_type": Database["public"]['Enums']["actor_type"],"actor_user_id": string | null,"correlation_id": string | null,"created_at": string,"id": number,"ip": unknown,"metadata": NonNullable<Json>,"organisation_id": string | null,"resource_id": string | null,"resource_type": string,"user_agent": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "action": string,"actor_agent_id"?: string | null,"actor_type": Database["public"]['Enums']["actor_type"],"actor_user_id"?: string | null,"correlation_id"?: string | null,"created_at"?: string,"id"?: never,"ip"?: unknown,"metadata"?: NonNullable<Json>,"organisation_id"?: string | null,"resource_id"?: string | null,"resource_type": string,"user_agent"?: string | null
                  }
                  Update: {
                    "action"?: string,"actor_agent_id"?: string | null,"actor_type"?: Database["public"]['Enums']["actor_type"],"actor_user_id"?: string | null,"correlation_id"?: string | null,"created_at"?: string,"id"?: never,"ip"?: unknown,"metadata"?: NonNullable<Json>,"organisation_id"?: string | null,"resource_id"?: string | null,"resource_type"?: string,"user_agent"?: string | null
                  }
                  Relationships: [
                    
                  ]
                },"autofill_tokens": {
                  Row: {
                    "created_at": string,"expires_at": string,"id": string,"label": string,"last_used_at": string | null,"organisation_id": string,"revoked_at": string | null,"token_hash": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"expires_at"?: string,"id"?: string,"label": string,"last_used_at"?: string | null,"organisation_id": string,"revoked_at"?: string | null,"token_hash": string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"expires_at"?: string,"id"?: string,"label"?: string,"last_used_at"?: string | null,"organisation_id"?: string,"revoked_at"?: string | null,"token_hash"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "autofill_tokens_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "autofill_tokens_organisation_id_user_id_fkey"
      columns: ["organisation_id","user_id"]
isOneToOne: false
      referencedRelation: "organisation_members"
      referencedColumns: ["organisation_id","user_id"]
    }
                  ]
                },"company_documents": {
                  Row: {
                    "archived_at": string | null,"created_at": string,"data_category": Database["public"]['Enums']["data_category"],"doc_type": string,"expires_at": string | null,"file_name": string,"id": string,"mime_type": string | null,"organisation_id": string,"size_bytes": number | null,"storage_path": string,"title": string,"uploaded_by": string | null,"verified": boolean,"verified_at": string | null,"verified_by": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "archived_at"?: string | null,"created_at"?: string,"data_category": Database["public"]['Enums']["data_category"],"doc_type": string,"expires_at"?: string | null,"file_name": string,"id"?: string,"mime_type"?: string | null,"organisation_id": string,"size_bytes"?: number | null,"storage_path": string,"title": string,"uploaded_by"?: string | null,"verified"?: boolean,"verified_at"?: string | null,"verified_by"?: string | null
                  }
                  Update: {
                    "archived_at"?: string | null,"created_at"?: string,"data_category"?: Database["public"]['Enums']["data_category"],"doc_type"?: string,"expires_at"?: string | null,"file_name"?: string,"id"?: string,"mime_type"?: string | null,"organisation_id"?: string,"size_bytes"?: number | null,"storage_path"?: string,"title"?: string,"uploaded_by"?: string | null,"verified"?: boolean,"verified_at"?: string | null,"verified_by"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "company_documents_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"company_profiles": {
                  Row: {
                    "authorised_signatory": string | null,"bbbee_expires_at": string | null,"bbbee_level": number | null,"cidb_grade": string | null,"contact_email": string | null,"contact_person": string | null,"contact_phone": string | null,"csd_number": string | null,"keywords": (string)[],"legal_name": string | null,"max_contract_value_zar": number | null,"organisation_id": string,"physical_address": string | null,"postal_address": string | null,"provinces": (string)[],"registration_number": string | null,"sectors": (string)[],"tax_pin": string | null,"tax_pin_expires_at": string | null,"trading_name": string | null,"updated_at": string,"updated_by": string | null,"vat_number": string | null,"website": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "authorised_signatory"?: string | null,"bbbee_expires_at"?: string | null,"bbbee_level"?: number | null,"cidb_grade"?: string | null,"contact_email"?: string | null,"contact_person"?: string | null,"contact_phone"?: string | null,"csd_number"?: string | null,"keywords"?: (string)[],"legal_name"?: string | null,"max_contract_value_zar"?: number | null,"organisation_id": string,"physical_address"?: string | null,"postal_address"?: string | null,"provinces"?: (string)[],"registration_number"?: string | null,"sectors"?: (string)[],"tax_pin"?: string | null,"tax_pin_expires_at"?: string | null,"trading_name"?: string | null,"updated_at"?: string,"updated_by"?: string | null,"vat_number"?: string | null,"website"?: string | null
                  }
                  Update: {
                    "authorised_signatory"?: string | null,"bbbee_expires_at"?: string | null,"bbbee_level"?: number | null,"cidb_grade"?: string | null,"contact_email"?: string | null,"contact_person"?: string | null,"contact_phone"?: string | null,"csd_number"?: string | null,"keywords"?: (string)[],"legal_name"?: string | null,"max_contract_value_zar"?: number | null,"organisation_id"?: string,"physical_address"?: string | null,"postal_address"?: string | null,"provinces"?: (string)[],"registration_number"?: string | null,"sectors"?: (string)[],"tax_pin"?: string | null,"tax_pin_expires_at"?: string | null,"trading_name"?: string | null,"updated_at"?: string,"updated_by"?: string | null,"vat_number"?: string | null,"website"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "company_profiles_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: true
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"cost_usage": {
                  Row: {
                    "agent_id": string | null,"cost_usd": number,"created_at": string,"id": number,"input_tokens": number,"is_simulated": boolean,"model": string,"organisation_id": string,"output_tokens": number,"provider": string,"task_id": string | null,"tender_id": string | null,"workflow_run_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "agent_id"?: string | null,"cost_usd"?: number,"created_at"?: string,"id"?: never,"input_tokens"?: number,"is_simulated"?: boolean,"model": string,"organisation_id": string,"output_tokens"?: number,"provider": string,"task_id"?: string | null,"tender_id"?: string | null,"workflow_run_id"?: string | null
                  }
                  Update: {
                    "agent_id"?: string | null,"cost_usd"?: number,"created_at"?: string,"id"?: never,"input_tokens"?: number,"is_simulated"?: boolean,"model"?: string,"organisation_id"?: string,"output_tokens"?: number,"provider"?: string,"task_id"?: string | null,"tender_id"?: string | null,"workflow_run_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "cost_usage_agent_id_fkey"
      columns: ["agent_id"]
isOneToOne: false
      referencedRelation: "agents"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "cost_usage_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "cost_usage_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "cost_usage_workflow_run_id_fkey"
      columns: ["workflow_run_id"]
isOneToOne: false
      referencedRelation: "workflow_runs"
      referencedColumns: ["id"]
    }
                  ]
                },"departments": {
                  Row: {
                    "accent": string,"created_at": string,"description": string,"id": string,"name": string,"organisation_id": string,"slug": string,"sort_order": number
                  }
                  ComputedFields: never
                  Insert: {
                    "accent"?: string,"created_at"?: string,"description"?: string,"id"?: string,"name": string,"organisation_id": string,"slug": string,"sort_order"?: number
                  }
                  Update: {
                    "accent"?: string,"created_at"?: string,"description"?: string,"id"?: string,"name"?: string,"organisation_id"?: string,"slug"?: string,"sort_order"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "departments_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"discovery_runs": {
                  Row: {
                    "completed_at": string | null,"created_at": string,"created_tenders": number,"error": string | null,"id": string,"matched": number,"methods": (string)[],"organisation_id": string,"provinces": (string)[],"requested_by": string | null,"rows_seen": number,"rows_skipped": number,"scanned": number,"source": string,"started_at": string | null,"started_workflows": number,"status": Database["public"]['Enums']["discovery_status"],"trigger": string
                  }
                  ComputedFields: never
                  Insert: {
                    "completed_at"?: string | null,"created_at"?: string,"created_tenders"?: number,"error"?: string | null,"id"?: string,"matched"?: number,"methods"?: (string)[],"organisation_id": string,"provinces": (string)[],"requested_by"?: string | null,"rows_seen"?: number,"rows_skipped"?: number,"scanned"?: number,"source"?: string,"started_at"?: string | null,"started_workflows"?: number,"status"?: Database["public"]['Enums']["discovery_status"],"trigger": string
                  }
                  Update: {
                    "completed_at"?: string | null,"created_at"?: string,"created_tenders"?: number,"error"?: string | null,"id"?: string,"matched"?: number,"methods"?: (string)[],"organisation_id"?: string,"provinces"?: (string)[],"requested_by"?: string | null,"rows_seen"?: number,"rows_skipped"?: number,"scanned"?: number,"source"?: string,"started_at"?: string | null,"started_workflows"?: number,"status"?: Database["public"]['Enums']["discovery_status"],"trigger"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "discovery_runs_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"email_accounts": {
                  Row: {
                    "created_at": string,"display_name": string | null,"from_address": string,"id": string,"last_error": string | null,"last_used_at": string | null,"organisation_id": string,"provider": Database["public"]['Enums']["email_provider"],"revoked_at": string | null,"secret_id": string,"smtp_host": string | null,"smtp_port": number | null,"smtp_username": string | null,"status": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"display_name"?: string | null,"from_address": string,"id"?: string,"last_error"?: string | null,"last_used_at"?: string | null,"organisation_id": string,"provider": Database["public"]['Enums']["email_provider"],"revoked_at"?: string | null,"secret_id": string,"smtp_host"?: string | null,"smtp_port"?: number | null,"smtp_username"?: string | null,"status"?: string,"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"display_name"?: string | null,"from_address"?: string,"id"?: string,"last_error"?: string | null,"last_used_at"?: string | null,"organisation_id"?: string,"provider"?: Database["public"]['Enums']["email_provider"],"revoked_at"?: string | null,"secret_id"?: string,"smtp_host"?: string | null,"smtp_port"?: number | null,"smtp_username"?: string | null,"status"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "email_accounts_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "email_accounts_organisation_id_user_id_fkey"
      columns: ["organisation_id","user_id"]
isOneToOne: false
      referencedRelation: "organisation_members"
      referencedColumns: ["organisation_id","user_id"]
    }
                  ]
                },"email_messages": {
                  Row: {
                    "attachments": NonNullable<Json>,"created_at": string,"email_account_id": string | null,"error": string | null,"from_address": string,"id": string,"organisation_id": string,"provider_message_id": string | null,"sent_by": string | null,"status": string,"subject": string,"submission_record_id": string | null,"tender_id": string,"to_address": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attachments"?: NonNullable<Json>,"created_at"?: string,"email_account_id"?: string | null,"error"?: string | null,"from_address": string,"id"?: string,"organisation_id": string,"provider_message_id"?: string | null,"sent_by"?: string | null,"status": string,"subject": string,"submission_record_id"?: string | null,"tender_id": string,"to_address": string
                  }
                  Update: {
                    "attachments"?: NonNullable<Json>,"created_at"?: string,"email_account_id"?: string | null,"error"?: string | null,"from_address"?: string,"id"?: string,"organisation_id"?: string,"provider_message_id"?: string | null,"sent_by"?: string | null,"status"?: string,"subject"?: string,"submission_record_id"?: string | null,"tender_id"?: string,"to_address"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "email_messages_email_account_id_fkey"
      columns: ["email_account_id"]
isOneToOne: false
      referencedRelation: "email_accounts"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "email_messages_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "email_messages_organisation_id_tender_id_fkey"
      columns: ["organisation_id","tender_id"]
isOneToOne: false
      referencedRelation: "tenders"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "email_messages_submission_record_id_fkey"
      columns: ["submission_record_id"]
isOneToOne: false
      referencedRelation: "submission_records"
      referencedColumns: ["id"]
    }
                  ]
                },"handoffs": {
                  Row: {
                    "accepted_at": string | null,"correlation_id": string | null,"created_at": string,"from_agent_id": string | null,"from_approval": boolean,"from_task_id": string | null,"handoff_type": string,"id": string,"organisation_id": string,"payload": NonNullable<Json>,"status": Database["public"]['Enums']["handoff_status"],"tender_id": string | null,"to_agent_id": string | null,"to_approval": boolean,"to_task_id": string | null,"workflow_run_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "accepted_at"?: string | null,"correlation_id"?: string | null,"created_at"?: string,"from_agent_id"?: string | null,"from_approval"?: boolean,"from_task_id"?: string | null,"handoff_type": string,"id"?: string,"organisation_id": string,"payload"?: NonNullable<Json>,"status"?: Database["public"]['Enums']["handoff_status"],"tender_id"?: string | null,"to_agent_id"?: string | null,"to_approval"?: boolean,"to_task_id"?: string | null,"workflow_run_id"?: string | null
                  }
                  Update: {
                    "accepted_at"?: string | null,"correlation_id"?: string | null,"created_at"?: string,"from_agent_id"?: string | null,"from_approval"?: boolean,"from_task_id"?: string | null,"handoff_type"?: string,"id"?: string,"organisation_id"?: string,"payload"?: NonNullable<Json>,"status"?: Database["public"]['Enums']["handoff_status"],"tender_id"?: string | null,"to_agent_id"?: string | null,"to_approval"?: boolean,"to_task_id"?: string | null,"workflow_run_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "handoffs_from_task_id_fkey"
      columns: ["from_task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "handoffs_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "handoffs_organisation_id_from_agent_id_fkey"
      columns: ["organisation_id","from_agent_id"]
isOneToOne: false
      referencedRelation: "agents"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "handoffs_organisation_id_tender_id_fkey"
      columns: ["organisation_id","tender_id"]
isOneToOne: false
      referencedRelation: "tenders"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "handoffs_organisation_id_to_agent_id_fkey"
      columns: ["organisation_id","to_agent_id"]
isOneToOne: false
      referencedRelation: "agents"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "handoffs_to_task_id_fkey"
      columns: ["to_task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "handoffs_workflow_run_id_fkey"
      columns: ["workflow_run_id"]
isOneToOne: false
      referencedRelation: "workflow_runs"
      referencedColumns: ["id"]
    }
                  ]
                },"jobs": {
                  Row: {
                    "attempts": number,"completed_at": string | null,"created_at": string,"dedupe_key": string | null,"id": number,"kind": string,"last_error": string | null,"locked_at": string | null,"locked_by": string | null,"max_attempts": number,"organisation_id": string,"payload": NonNullable<Json>,"run_at": string,"status": Database["public"]['Enums']["job_status"],"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "attempts"?: number,"completed_at"?: string | null,"created_at"?: string,"dedupe_key"?: string | null,"id"?: never,"kind": string,"last_error"?: string | null,"locked_at"?: string | null,"locked_by"?: string | null,"max_attempts"?: number,"organisation_id": string,"payload"?: NonNullable<Json>,"run_at"?: string,"status"?: Database["public"]['Enums']["job_status"],"updated_at"?: string
                  }
                  Update: {
                    "attempts"?: number,"completed_at"?: string | null,"created_at"?: string,"dedupe_key"?: string | null,"id"?: never,"kind"?: string,"last_error"?: string | null,"locked_at"?: string | null,"locked_by"?: string | null,"max_attempts"?: number,"organisation_id"?: string,"payload"?: NonNullable<Json>,"run_at"?: string,"status"?: Database["public"]['Enums']["job_status"],"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "jobs_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"legal_acceptances": {
                  Row: {
                    "accepted_at": string,"id": number,"ip_hmac": string | null,"kind": string,"user_id": string,"version": string
                  }
                  ComputedFields: never
                  Insert: {
                    "accepted_at"?: string,"id"?: never,"ip_hmac"?: string | null,"kind": string,"user_id": string,"version": string
                  }
                  Update: {
                    "accepted_at"?: string,"id"?: never,"ip_hmac"?: string | null,"kind"?: string,"user_id"?: string,"version"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "legal_acceptances_document_fk"
      columns: ["kind","version"]
isOneToOne: false
      referencedRelation: "legal_documents"
      referencedColumns: ["kind","version"]
    }
                  ]
                },"legal_documents": {
                  Row: {
                    "is_current": boolean,"kind": string,"published_at": string,"version": string
                  }
                  ComputedFields: never
                  Insert: {
                    "is_current"?: boolean,"kind": string,"published_at"?: string,"version": string
                  }
                  Update: {
                    "is_current"?: boolean,"kind"?: string,"published_at"?: string,"version"?: string
                  }
                  Relationships: [
                    
                  ]
                },"notifications": {
                  Row: {
                    "body": string | null,"created_at": string,"id": string,"kind": string,"link": string | null,"organisation_id": string,"read_at": string | null,"severity": Database["public"]['Enums']["event_severity"],"title": string,"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "body"?: string | null,"created_at"?: string,"id"?: string,"kind": string,"link"?: string | null,"organisation_id": string,"read_at"?: string | null,"severity"?: Database["public"]['Enums']["event_severity"],"title": string,"user_id": string
                  }
                  Update: {
                    "body"?: string | null,"created_at"?: string,"id"?: string,"kind"?: string,"link"?: string | null,"organisation_id"?: string,"read_at"?: string | null,"severity"?: Database["public"]['Enums']["event_severity"],"title"?: string,"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "notifications_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"organisation_members": {
                  Row: {
                    "created_at": string,"organisation_id": string,"role": Database["public"]['Enums']["org_role"],"user_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"organisation_id": string,"role"?: Database["public"]['Enums']["org_role"],"user_id": string
                  }
                  Update: {
                    "created_at"?: string,"organisation_id"?: string,"role"?: Database["public"]['Enums']["org_role"],"user_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "organisation_members_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"organisations": {
                  Row: {
                    "created_at": string,"id": string,"name": string,"slug": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"id"?: string,"name": string,"slug": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"id"?: string,"name"?: string,"slug"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"profiles": {
                  Row: {
                    "created_at": string,"full_name": string | null,"id": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "created_at"?: string,"full_name"?: string | null,"id": string,"updated_at"?: string
                  }
                  Update: {
                    "created_at"?: string,"full_name"?: string | null,"id"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    
                  ]
                },"submission_records": {
                  Row: {
                    "approval_id": string,"created_at": string,"destination": string | null,"external_reference": string | null,"id": string,"is_simulation": boolean,"method": Database["public"]['Enums']["submission_method"],"organisation_id": string,"package_hash": string | null,"receipt": NonNullable<Json>,"status": Database["public"]['Enums']["submission_status"],"submitted_at": string | null,"tender_id": string,"workflow_run_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "approval_id": string,"created_at"?: string,"destination"?: string | null,"external_reference"?: string | null,"id"?: string,"is_simulation": boolean,"method": Database["public"]['Enums']["submission_method"],"organisation_id": string,"package_hash"?: string | null,"receipt"?: NonNullable<Json>,"status"?: Database["public"]['Enums']["submission_status"],"submitted_at"?: string | null,"tender_id": string,"workflow_run_id"?: string | null
                  }
                  Update: {
                    "approval_id"?: string,"created_at"?: string,"destination"?: string | null,"external_reference"?: string | null,"id"?: string,"is_simulation"?: boolean,"method"?: Database["public"]['Enums']["submission_method"],"organisation_id"?: string,"package_hash"?: string | null,"receipt"?: NonNullable<Json>,"status"?: Database["public"]['Enums']["submission_status"],"submitted_at"?: string | null,"tender_id"?: string,"workflow_run_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "submission_records_approval_id_fkey"
      columns: ["approval_id"]
isOneToOne: false
      referencedRelation: "approvals"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "submission_records_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "submission_records_organisation_id_tender_id_fkey"
      columns: ["organisation_id","tender_id"]
isOneToOne: false
      referencedRelation: "tenders"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "submission_records_workflow_run_id_fkey"
      columns: ["workflow_run_id"]
isOneToOne: false
      referencedRelation: "workflow_runs"
      referencedColumns: ["id"]
    }
                  ]
                },"system_settings": {
                  Row: {
                    "audit_retention_days": number,"auto_run_workflows": boolean,"budget_warning_pct": number,"daily_ai_budget_usd": number,"default_max_retries": number,"kill_switch": boolean,"last_discovery_at": string | null,"max_auto_workflows_per_scan": number,"max_tasks_per_workflow": number,"monthly_ai_budget_usd": number,"onboarding_completed_at": string | null,"organisation_id": string,"per_tender_budget_usd": number,"simulation_mode": boolean,"updated_at": string,"updated_by": string | null,"watched_methods": (string)[],"watched_provinces": (string)[]
                  }
                  ComputedFields: never
                  Insert: {
                    "audit_retention_days"?: number,"auto_run_workflows"?: boolean,"budget_warning_pct"?: number,"daily_ai_budget_usd"?: number,"default_max_retries"?: number,"kill_switch"?: boolean,"last_discovery_at"?: string | null,"max_auto_workflows_per_scan"?: number,"max_tasks_per_workflow"?: number,"monthly_ai_budget_usd"?: number,"onboarding_completed_at"?: string | null,"organisation_id": string,"per_tender_budget_usd"?: number,"simulation_mode"?: boolean,"updated_at"?: string,"updated_by"?: string | null,"watched_methods"?: (string)[],"watched_provinces"?: (string)[]
                  }
                  Update: {
                    "audit_retention_days"?: number,"auto_run_workflows"?: boolean,"budget_warning_pct"?: number,"daily_ai_budget_usd"?: number,"default_max_retries"?: number,"kill_switch"?: boolean,"last_discovery_at"?: string | null,"max_auto_workflows_per_scan"?: number,"max_tasks_per_workflow"?: number,"monthly_ai_budget_usd"?: number,"onboarding_completed_at"?: string | null,"organisation_id"?: string,"per_tender_budget_usd"?: number,"simulation_mode"?: boolean,"updated_at"?: string,"updated_by"?: string | null,"watched_methods"?: (string)[],"watched_provinces"?: (string)[]
                  }
                  Relationships: [
                    {
      foreignKeyName: "system_settings_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: true
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"task_dependencies": {
                  Row: {
                    "depends_on_task_id": string,"organisation_id": string,"task_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "depends_on_task_id": string,"organisation_id": string,"task_id": string
                  }
                  Update: {
                    "depends_on_task_id"?: string,"organisation_id"?: string,"task_id"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "task_dependencies_depends_on_task_id_fkey"
      columns: ["depends_on_task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "task_dependencies_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "task_dependencies_task_id_fkey"
      columns: ["task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    }
                  ]
                },"tasks": {
                  Row: {
                    "actual_cost_usd": number,"agent_id": string,"approval_id": string | null,"approval_required": boolean,"blocked_reason": string | null,"completed_at": string | null,"correlation_id": string | null,"cost_estimate_usd": number | null,"created_at": string,"description": string,"error": string | null,"failed_at": string | null,"id": string,"idempotency_key": string | null,"input": NonNullable<Json>,"max_retries": number,"organisation_id": string,"output": Json | null,"parent_task_id": string | null,"priority": number,"progress": number,"progress_message": string | null,"retry_count": number,"started_at": string | null,"status": Database["public"]['Enums']["task_status"],"step_key": string | null,"tender_id": string | null,"timeout_seconds": number,"title": string,"type": string,"updated_at": string,"workflow_run_id": string | null
                  }
                  ComputedFields: never
                  Insert: {
                    "actual_cost_usd"?: number,"agent_id": string,"approval_id"?: string | null,"approval_required"?: boolean,"blocked_reason"?: string | null,"completed_at"?: string | null,"correlation_id"?: string | null,"cost_estimate_usd"?: number | null,"created_at"?: string,"description"?: string,"error"?: string | null,"failed_at"?: string | null,"id"?: string,"idempotency_key"?: string | null,"input"?: NonNullable<Json>,"max_retries"?: number,"organisation_id": string,"output"?: Json | null,"parent_task_id"?: string | null,"priority"?: number,"progress"?: number,"progress_message"?: string | null,"retry_count"?: number,"started_at"?: string | null,"status"?: Database["public"]['Enums']["task_status"],"step_key"?: string | null,"tender_id"?: string | null,"timeout_seconds"?: number,"title": string,"type": string,"updated_at"?: string,"workflow_run_id"?: string | null
                  }
                  Update: {
                    "actual_cost_usd"?: number,"agent_id"?: string,"approval_id"?: string | null,"approval_required"?: boolean,"blocked_reason"?: string | null,"completed_at"?: string | null,"correlation_id"?: string | null,"cost_estimate_usd"?: number | null,"created_at"?: string,"description"?: string,"error"?: string | null,"failed_at"?: string | null,"id"?: string,"idempotency_key"?: string | null,"input"?: NonNullable<Json>,"max_retries"?: number,"organisation_id"?: string,"output"?: Json | null,"parent_task_id"?: string | null,"priority"?: number,"progress"?: number,"progress_message"?: string | null,"retry_count"?: number,"started_at"?: string | null,"status"?: Database["public"]['Enums']["task_status"],"step_key"?: string | null,"tender_id"?: string | null,"timeout_seconds"?: number,"title"?: string,"type"?: string,"updated_at"?: string,"workflow_run_id"?: string | null
                  }
                  Relationships: [
                    {
      foreignKeyName: "tasks_approval_fk"
      columns: ["approval_id"]
isOneToOne: false
      referencedRelation: "approvals"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tasks_organisation_id_agent_id_fkey"
      columns: ["organisation_id","agent_id"]
isOneToOne: false
      referencedRelation: "agents"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "tasks_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tasks_organisation_id_tender_id_fkey"
      columns: ["organisation_id","tender_id"]
isOneToOne: false
      referencedRelation: "tenders"
      referencedColumns: ["organisation_id","id"]
    },{
      foreignKeyName: "tasks_parent_task_id_fkey"
      columns: ["parent_task_id"]
isOneToOne: false
      referencedRelation: "tasks"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tasks_workflow_run_id_fkey"
      columns: ["workflow_run_id"]
isOneToOne: false
      referencedRelation: "workflow_runs"
      referencedColumns: ["id"]
    }
                  ]
                },"tender_sources": {
                  Row: {
                    "base_url": string | null,"config": NonNullable<Json>,"created_at": string,"enabled": boolean,"id": string,"kind": Database["public"]['Enums']["tender_source_kind"],"name": string,"organisation_id": string,"slug": string
                  }
                  ComputedFields: never
                  Insert: {
                    "base_url"?: string | null,"config"?: NonNullable<Json>,"created_at"?: string,"enabled"?: boolean,"id"?: string,"kind": Database["public"]['Enums']["tender_source_kind"],"name": string,"organisation_id": string,"slug": string
                  }
                  Update: {
                    "base_url"?: string | null,"config"?: NonNullable<Json>,"created_at"?: string,"enabled"?: boolean,"id"?: string,"kind"?: Database["public"]['Enums']["tender_source_kind"],"name"?: string,"organisation_id"?: string,"slug"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tender_sources_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    }
                  ]
                },"tender_status_history": {
                  Row: {
                    "actor_agent_id": string | null,"actor_type": Database["public"]['Enums']["actor_type"],"actor_user_id": string | null,"created_at": string,"from_status": Database["public"]['Enums']["tender_status"] | null,"id": number,"organisation_id": string,"reason": string | null,"tender_id": string,"to_status": Database["public"]['Enums']["tender_status"]
                  }
                  ComputedFields: never
                  Insert: {
                    "actor_agent_id"?: string | null,"actor_type": Database["public"]['Enums']["actor_type"],"actor_user_id"?: string | null,"created_at"?: string,"from_status"?: Database["public"]['Enums']["tender_status"] | null,"id"?: never,"organisation_id": string,"reason"?: string | null,"tender_id": string,"to_status": Database["public"]['Enums']["tender_status"]
                  }
                  Update: {
                    "actor_agent_id"?: string | null,"actor_type"?: Database["public"]['Enums']["actor_type"],"actor_user_id"?: string | null,"created_at"?: string,"from_status"?: Database["public"]['Enums']["tender_status"] | null,"id"?: never,"organisation_id"?: string,"reason"?: string | null,"tender_id"?: string,"to_status"?: Database["public"]['Enums']["tender_status"]
                  }
                  Relationships: [
                    {
      foreignKeyName: "tender_status_history_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tender_status_history_tender_id_fkey"
      columns: ["tender_id"]
isOneToOne: false
      referencedRelation: "tenders"
      referencedColumns: ["id"]
    }
                  ]
                },"tenders": {
                  Row: {
                    "briefing_at": string | null,"briefing_compulsory": boolean,"briefing_location": string | null,"closing_at": string,"created_at": string,"created_by": string | null,"description": string | null,"documents": NonNullable<Json>,"estimated_value_zar": number | null,"id": string,"is_simulation": boolean,"issuing_organisation": string,"organisation_id": string,"province": string,"published_at": string | null,"questions_deadline_at": string | null,"reference_number": string | null,"sector": string | null,"source_id": string | null,"source_ref": string | null,"source_url": string | null,"status": Database["public"]['Enums']["tender_status"],"status_changed_at": string,"submission_destination": string | null,"submission_method": Database["public"]['Enums']["submission_method"],"title": string,"updated_at": string
                  }
                  ComputedFields: never
                  Insert: {
                    "briefing_at"?: string | null,"briefing_compulsory"?: boolean,"briefing_location"?: string | null,"closing_at": string,"created_at"?: string,"created_by"?: string | null,"description"?: string | null,"documents"?: NonNullable<Json>,"estimated_value_zar"?: number | null,"id"?: string,"is_simulation"?: boolean,"issuing_organisation": string,"organisation_id": string,"province"?: string,"published_at"?: string | null,"questions_deadline_at"?: string | null,"reference_number"?: string | null,"sector"?: string | null,"source_id"?: string | null,"source_ref"?: string | null,"source_url"?: string | null,"status"?: Database["public"]['Enums']["tender_status"],"status_changed_at"?: string,"submission_destination"?: string | null,"submission_method"?: Database["public"]['Enums']["submission_method"],"title": string,"updated_at"?: string
                  }
                  Update: {
                    "briefing_at"?: string | null,"briefing_compulsory"?: boolean,"briefing_location"?: string | null,"closing_at"?: string,"created_at"?: string,"created_by"?: string | null,"description"?: string | null,"documents"?: NonNullable<Json>,"estimated_value_zar"?: number | null,"id"?: string,"is_simulation"?: boolean,"issuing_organisation"?: string,"organisation_id"?: string,"province"?: string,"published_at"?: string | null,"questions_deadline_at"?: string | null,"reference_number"?: string | null,"sector"?: string | null,"source_id"?: string | null,"source_ref"?: string | null,"source_url"?: string | null,"status"?: Database["public"]['Enums']["tender_status"],"status_changed_at"?: string,"submission_destination"?: string | null,"submission_method"?: Database["public"]['Enums']["submission_method"],"title"?: string,"updated_at"?: string
                  }
                  Relationships: [
                    {
      foreignKeyName: "tenders_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "tenders_source_fkey"
      columns: ["organisation_id","source_id"]
isOneToOne: false
      referencedRelation: "tender_sources"
      referencedColumns: ["organisation_id","id"]
    }
                  ]
                },"worker_heartbeats": {
                  Row: {
                    "in_flight": number,"last_seen_at": string,"processed": number,"started_at": string,"version": string | null,"worker_id": string
                  }
                  ComputedFields: never
                  Insert: {
                    "in_flight"?: number,"last_seen_at"?: string,"processed"?: number,"started_at"?: string,"version"?: string | null,"worker_id": string
                  }
                  Update: {
                    "in_flight"?: number,"last_seen_at"?: string,"processed"?: number,"started_at"?: string,"version"?: string | null,"worker_id"?: string
                  }
                  Relationships: [
                    
                  ]
                },"workflow_runs": {
                  Row: {
                    "completed_at": string | null,"correlation_id": string,"created_at": string,"current_step": string | null,"error": string | null,"failed_at": string | null,"id": string,"is_simulation": boolean,"max_tasks": number,"options": NonNullable<Json>,"organisation_id": string,"outcome": string | null,"started_at": string | null,"started_by": string | null,"status": Database["public"]['Enums']["workflow_run_status"],"task_count": number,"tender_id": string,"updated_at": string,"workflow_key": string,"workflow_version": number
                  }
                  ComputedFields: never
                  Insert: {
                    "completed_at"?: string | null,"correlation_id"?: string,"created_at"?: string,"current_step"?: string | null,"error"?: string | null,"failed_at"?: string | null,"id"?: string,"is_simulation"?: boolean,"max_tasks": number,"options"?: NonNullable<Json>,"organisation_id": string,"outcome"?: string | null,"started_at"?: string | null,"started_by"?: string | null,"status"?: Database["public"]['Enums']["workflow_run_status"],"task_count"?: number,"tender_id": string,"updated_at"?: string,"workflow_key": string,"workflow_version"?: number
                  }
                  Update: {
                    "completed_at"?: string | null,"correlation_id"?: string,"created_at"?: string,"current_step"?: string | null,"error"?: string | null,"failed_at"?: string | null,"id"?: string,"is_simulation"?: boolean,"max_tasks"?: number,"options"?: NonNullable<Json>,"organisation_id"?: string,"outcome"?: string | null,"started_at"?: string | null,"started_by"?: string | null,"status"?: Database["public"]['Enums']["workflow_run_status"],"task_count"?: number,"tender_id"?: string,"updated_at"?: string,"workflow_key"?: string,"workflow_version"?: number
                  }
                  Relationships: [
                    {
      foreignKeyName: "workflow_runs_organisation_id_fkey"
      columns: ["organisation_id"]
isOneToOne: false
      referencedRelation: "organisations"
      referencedColumns: ["id"]
    },{
      foreignKeyName: "workflow_runs_organisation_id_tender_id_fkey"
      columns: ["organisation_id","tender_id"]
isOneToOne: false
      referencedRelation: "tenders"
      referencedColumns: ["organisation_id","id"]
    }
                  ]
                }
          }
          Views: {
            [_ in never]: never
          }
          Functions: {
            "accept_legal":
{ Args: { "p_ip_hmac"?: string,"p_privacy_version": string,"p_terms_version": string }; Returns: undefined
                           },
"archive_company_document":
{ Args: { "p_id": string }; Returns: undefined
                           },
"autofill_document_download":
{ Args: { "p_document_id": string,"p_token_id": string }; Returns: {
              "file_name": string,"mime_type": string,"size_bytes": number,"storage_path": string
            }[]
                           },
"autofill_documents":
{ Args: { "p_token_id": string }; Returns: {
              "created_at": string,"doc_type": string,"expires_at": string,"file_name": string,"id": string,"mime_type": string,"size_bytes": number,"title": string
            }[]
                           },
"autofill_record_prepared":
{ Args: { "p_confirmed_host": boolean,"p_documents": number,"p_fields": number,"p_host": string,"p_left": number,"p_sensitive": boolean,"p_tender_id": string,"p_token_id": string }; Returns: undefined
                           },
"bootstrap_organisation":
{ Args: { "p_agents": Json,"p_departments": Json,"p_name": string,"p_slug": string,"p_user_id": string }; Returns: string
                           },
"cancel_workflow":
{ Args: { "p_reason": string,"p_run_id": string }; Returns: undefined
                           },
"change_tender_delivery":
{ Args: { "p_changes": Json,"p_reason": string,"p_tender_id": string }; Returns: Json
                           },
"complete_onboarding":
{ Args: { "p_org": string }; Returns: undefined
                           },
"connect_email_account":
{ Args: { "p_display_name": string,"p_from": string,"p_org": string,"p_provider": Database["public"]['Enums']["email_provider"],"p_secret": string,"p_smtp_host"?: string,"p_smtp_port"?: number,"p_smtp_username"?: string }; Returns: string
                           },
"create_autofill_token":
{ Args: { "p_label"?: string,"p_org": string }; Returns: string
                           },
"dashboard_counts":
{ Args: { "p_day_start": string,"p_month_start": string,"p_org": string }; Returns: Json
                           },
"decide_approval":
{ Args: { "p_approval_id": string,"p_approve": boolean,"p_comments"?: string }; Returns: Database["public"]['Enums']["approval_status"]
                           },
"disconnect_email_account":
{ Args: { "p_id": string }; Returns: undefined
                           },
"document_download":
{ Args: { "p_id": string }; Returns: {
              "file_name": string,"storage_path": string
            }[]
                           },
"email_account_credential":
{ Args: { "p_id": string,"p_user": string }; Returns: {
              "display_name": string,"from_address": string,"organisation_id": string,"provider": Database["public"]['Enums']["email_provider"],"secret": string,"smtp_host": string,"smtp_port": number,"smtp_username": string
            }[]
                           },
"erase_organisation":
{ Args: { "p_org": string,"p_reference"?: string }; Returns: Json
                           },
"erase_user":
{ Args: { "p_reference"?: string,"p_user_id": string }; Returns: Json
                           },
"export_organisation_data":
{ Args: { "p_actor"?: string,"p_org": string }; Returns: Json
                           },
"export_user_data":
{ Args: { "p_actor"?: string,"p_user_id": string }; Returns: Json
                           },
"hit_rate_limit":
{ Args: { "p_action": string,"p_max"?: number,"p_window_seconds"?: number }; Returns: undefined
                           },
"hit_rate_limit_key":
{ Args: { "p_action": string,"p_key": string,"p_max"?: number,"p_window_seconds"?: number }; Returns: undefined
                           },
"mark_notifications_read":
{ Args: { "p_ids": (string)[] }; Returns: undefined
                           },
"pending_legal_acceptances":
{ Args: Record<PropertyKey, never>; Returns: {
              "kind": string,"version": string
            }[]
                           },
"record_bid_delivery":
{ Args: { "p_note"?: string,"p_reference"?: string,"p_submission_id": string }; Returns: undefined
                           },
"register_company_document":
{ Args: { "p_doc_type": string,"p_expires_at"?: string,"p_org": string,"p_path": string,"p_title": string }; Returns: string
                           },
"rerun_bid":
{ Args: { "p_tender_id": string }; Returns: string
                           },
"resolve_autofill_token":
{ Args: { "p_hash": string }; Returns: {
              "organisation_id": string,"role": Database["public"]['Enums']["org_role"],"token_id": string,"user_id": string
            }[]
                           },
"retry_task":
{ Args: { "p_task_id": string }; Returns: undefined
                           },
"revoke_autofill_token":
{ Args: { "p_id": string }; Returns: undefined
                           },
"set_agent_control":
{ Args: { "p_action": string,"p_agent_id": string,"p_reason"?: string }; Returns: Database["public"]['Enums']["agent_status"]
                           },
"set_kill_switch":
{ Args: { "p_engaged": boolean,"p_org": string,"p_reason": string }; Returns: undefined
                           },
"set_watched_methods":
{ Args: { "p_methods": (string)[],"p_org": string }; Returns: undefined
                           },
"set_watched_provinces":
{ Args: { "p_auto_run": boolean,"p_org": string,"p_provinces": (string)[] }; Returns: undefined
                           },
"start_discovery":
{ Args: { "p_org": string,"p_provinces"?: (string)[] }; Returns: string
                           },
"start_tender_workflow":
{ Args: { "p_options"?: Json,"p_tender_id": string,"p_workflow_key"?: string }; Returns: string
                           },
"transition_tender":
{ Args: { "p_reason": string,"p_tender_id": string,"p_to": Database["public"]['Enums']["tender_status"] }; Returns: Database["public"]['Enums']["tender_status"]
                           },
"update_email_account_secret":
{ Args: { "p_id": string,"p_secret": string }; Returns: undefined
                           },
"verify_company_document":
{ Args: { "p_id": string }; Returns: undefined
                           },
"worker_health":
{ Args: Record<PropertyKey, never>; Returns: {
              "last_seen_at": string,"workers": number
            }[]
                           }
          }
          Enums: {
            "access_level": "READ"|"WRITE","actor_type": "user"|"agent"|"system","agent_status": "IDLE"|"QUEUED"|"RUNNING"|"WAITING"|"BLOCKED"|"NEEDS_APPROVAL"|"PAUSED"|"COMPLETED"|"FAILED"|"DISABLED","approval_status": "PENDING"|"APPROVED"|"REJECTED"|"EXPIRED"|"CANCELLED","approval_type": "FINAL_PRICING"|"LEGAL_DECLARATION"|"BID_SUBMISSION"|"CLARIFICATION_EMAIL"|"CONTRACT_ACCEPTANCE"|"FINANCIAL_COMMITMENT"|"SENSITIVE_DOCUMENT_DISCLOSURE"|"EXCEPTION","cost_tier": "LOW"|"MID"|"HIGH","data_category": "PUBLIC_TENDER_DATA"|"TENDER_DOCUMENTS"|"COMPANY_PROFILE"|"COMPANY_CAPABILITIES"|"PROJECT_REFERENCES"|"FINANCIAL"|"BANKING"|"TAX"|"BBBEE"|"DIRECTOR_PERSONAL"|"PROOF_OF_ADDRESS"|"INSURANCE"|"CERTIFICATIONS"|"PRICING"|"COMMUNICATIONS"|"SUBMISSION","discovery_status": "QUEUED"|"RUNNING"|"COMPLETED"|"FAILED","email_provider": "GMAIL"|"SMTP","event_severity": "DEBUG"|"INFO"|"WARNING"|"ERROR"|"CRITICAL","handoff_status": "PENDING"|"ACCEPTED"|"REJECTED"|"CANCELLED","job_status": "QUEUED"|"RUNNING"|"COMPLETED"|"FAILED"|"DEAD","org_role": "owner"|"admin"|"operator"|"viewer","risk_level": "LOW"|"MEDIUM"|"HIGH"|"CRITICAL","submission_method": "ELECTRONIC_PORTAL"|"EMAIL"|"PHYSICAL"|"UNKNOWN","submission_status": "PREPARING"|"SUBMITTED"|"FAILED"|"ACTION_REQUIRED","task_status": "QUEUED"|"RUNNING"|"WAITING"|"BLOCKED"|"NEEDS_APPROVAL"|"COMPLETED"|"FAILED"|"CANCELLED","tender_source_kind": "MANUAL"|"PORTAL"|"EMAIL"|"API","tender_status": "DISCOVERED"|"INGESTING"|"ANALYSING"|"QUALIFYING"|"REJECTED"|"QUALIFIED"|"COMPLIANCE_REVIEW"|"MISSING_INFORMATION"|"PREPARING_BID"|"PRICING"|"QUALITY_ASSURANCE"|"QA_FAILED"|"READY_FOR_APPROVAL"|"APPROVED"|"SUBMITTING"|"SUBMITTED"|"SUBMISSION_FAILED"|"UNDER_EVALUATION"|"CLARIFICATION"|"AWARDED"|"UNSUCCESSFUL"|"CANCELLED"|"ARCHIVED","workflow_run_status": "PENDING"|"RUNNING"|"WAITING_APPROVAL"|"BLOCKED"|"COMPLETED"|"FAILED"|"CANCELLED"
          }
          CompositeTypes: {
            [_ in never]: never
          }
        }
}

type DatabaseWithoutInternals = Omit<Database, '__InternalSupabase'>

type DefaultSchema = DatabaseWithoutInternals[Extract<keyof Database, "public">]

export type Tables<
  DefaultSchemaTableNameOrOptions extends
    | keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
        DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] & DefaultSchema["Views"])
  ? (DefaultSchema["Tables"] & DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
      Row: infer R
    }
    ? R
    : never
  : never

export type TablesInsert<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Insert: infer I
    }
    ? I
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Insert: infer I
    }
    ? I
    : never
  : never

export type TablesUpdate<
  DefaultSchemaTableNameOrOptions extends
    | keyof DefaultSchema["Tables"]
    | { schema: keyof DatabaseWithoutInternals },
  TableName extends DefaultSchemaTableNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"]
    : never = never
> = DefaultSchemaTableNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"][TableName] extends {
      Update: infer U
    }
    ? U
    : never
  : DefaultSchemaTableNameOrOptions extends keyof DefaultSchema["Tables"]
  ? DefaultSchema["Tables"][DefaultSchemaTableNameOrOptions] extends {
      Update: infer U
    }
    ? U
    : never
  : never

export type Enums<
  DefaultSchemaEnumNameOrOptions extends
    | keyof DefaultSchema["Enums"]
    | { schema: keyof DatabaseWithoutInternals },
  EnumName extends DefaultSchemaEnumNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"]
    : never = never
> = DefaultSchemaEnumNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[DefaultSchemaEnumNameOrOptions["schema"]]["Enums"][EnumName]
  : DefaultSchemaEnumNameOrOptions extends keyof DefaultSchema["Enums"]
  ? DefaultSchema["Enums"][DefaultSchemaEnumNameOrOptions]
  : never

export type CompositeTypes<
  PublicCompositeTypeNameOrOptions extends
    | keyof DefaultSchema["CompositeTypes"]
    | { schema: keyof DatabaseWithoutInternals },
  CompositeTypeName extends PublicCompositeTypeNameOrOptions extends {
    schema: keyof DatabaseWithoutInternals
  }
    ? keyof DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"]
    : never = never
> = PublicCompositeTypeNameOrOptions extends { schema: keyof DatabaseWithoutInternals }
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
  ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
  : never

export const Constants = {
  "graphql_public": {
          Enums: {
            
          }
        },"public": {
          Enums: {
            "access_level": ["READ", "WRITE"],"actor_type": ["user", "agent", "system"],"agent_status": ["IDLE", "QUEUED", "RUNNING", "WAITING", "BLOCKED", "NEEDS_APPROVAL", "PAUSED", "COMPLETED", "FAILED", "DISABLED"],"approval_status": ["PENDING", "APPROVED", "REJECTED", "EXPIRED", "CANCELLED"],"approval_type": ["FINAL_PRICING", "LEGAL_DECLARATION", "BID_SUBMISSION", "CLARIFICATION_EMAIL", "CONTRACT_ACCEPTANCE", "FINANCIAL_COMMITMENT", "SENSITIVE_DOCUMENT_DISCLOSURE", "EXCEPTION"],"cost_tier": ["LOW", "MID", "HIGH"],"data_category": ["PUBLIC_TENDER_DATA", "TENDER_DOCUMENTS", "COMPANY_PROFILE", "COMPANY_CAPABILITIES", "PROJECT_REFERENCES", "FINANCIAL", "BANKING", "TAX", "BBBEE", "DIRECTOR_PERSONAL", "PROOF_OF_ADDRESS", "INSURANCE", "CERTIFICATIONS", "PRICING", "COMMUNICATIONS", "SUBMISSION"],"discovery_status": ["QUEUED", "RUNNING", "COMPLETED", "FAILED"],"email_provider": ["GMAIL", "SMTP"],"event_severity": ["DEBUG", "INFO", "WARNING", "ERROR", "CRITICAL"],"handoff_status": ["PENDING", "ACCEPTED", "REJECTED", "CANCELLED"],"job_status": ["QUEUED", "RUNNING", "COMPLETED", "FAILED", "DEAD"],"org_role": ["owner", "admin", "operator", "viewer"],"risk_level": ["LOW", "MEDIUM", "HIGH", "CRITICAL"],"submission_method": ["ELECTRONIC_PORTAL", "EMAIL", "PHYSICAL", "UNKNOWN"],"submission_status": ["PREPARING", "SUBMITTED", "FAILED", "ACTION_REQUIRED"],"task_status": ["QUEUED", "RUNNING", "WAITING", "BLOCKED", "NEEDS_APPROVAL", "COMPLETED", "FAILED", "CANCELLED"],"tender_source_kind": ["MANUAL", "PORTAL", "EMAIL", "API"],"tender_status": ["DISCOVERED", "INGESTING", "ANALYSING", "QUALIFYING", "REJECTED", "QUALIFIED", "COMPLIANCE_REVIEW", "MISSING_INFORMATION", "PREPARING_BID", "PRICING", "QUALITY_ASSURANCE", "QA_FAILED", "READY_FOR_APPROVAL", "APPROVED", "SUBMITTING", "SUBMITTED", "SUBMISSION_FAILED", "UNDER_EVALUATION", "CLARIFICATION", "AWARDED", "UNSUCCESSFUL", "CANCELLED", "ARCHIVED"],"workflow_run_status": ["PENDING", "RUNNING", "WAITING_APPROVAL", "BLOCKED", "COMPLETED", "FAILED", "CANCELLED"]
          }
        }
} as const

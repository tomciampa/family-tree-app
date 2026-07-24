export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[]

export type Database = {
  // Allows to automatically instantiate createClient with right options
  // instead of createClient<Database, { PostgrestVersion: 'XX' }>(URL, KEY)
  __InternalSupabase: {
    PostgrestVersion: "14.5"
  }
  public: {
    Tables: {
      anecdotes: {
        Row: {
          contributor_id: string | null
          document_id: string | null
          family_id: string | null
          id: string
          person_id: string | null
          recorded_at: string | null
          story_text: string
          who_told_it: string | null
        }
        Insert: {
          contributor_id?: string | null
          document_id?: string | null
          family_id?: string | null
          id?: string
          person_id?: string | null
          recorded_at?: string | null
          story_text: string
          who_told_it?: string | null
        }
        Update: {
          contributor_id?: string | null
          document_id?: string | null
          family_id?: string | null
          id?: string
          person_id?: string | null
          recorded_at?: string | null
          story_text?: string
          who_told_it?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "anecdotes_contributor_id_fkey"
            columns: ["contributor_id"]
            isOneToOne: false
            referencedRelation: "contributors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "anecdotes_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "anecdotes_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "anecdotes_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      contributors: {
        Row: {
          auth_user_id: string | null
          created_at: string | null
          display_name: string
          family_id: string | null
          id: string
          linked_person_id: string | null
        }
        Insert: {
          auth_user_id?: string | null
          created_at?: string | null
          display_name: string
          family_id?: string | null
          id?: string
          linked_person_id?: string | null
        }
        Update: {
          auth_user_id?: string | null
          created_at?: string | null
          display_name?: string
          family_id?: string | null
          id?: string
          linked_person_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "contributors_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "contributors_linked_person_id_fkey"
            columns: ["linked_person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      document_people: {
        Row: {
          document_id: string
          person_id: string
        }
        Insert: {
          document_id: string
          person_id: string
        }
        Update: {
          document_id?: string
          person_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "document_people_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "document_people_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      documents: {
        Row: {
          audio_end_seconds: number | null
          audio_start_seconds: number | null
          candidate_people: Json | null
          document_type: string | null
          family_id: string | null
          file_path: string
          filename: string | null
          id: string
          interview_summary: string | null
          interviewee_person_id: string | null
          kind: string | null
          parent_document_id: string | null
          recorded_at: string | null
          status: string
          transcription_raw: string | null
          uploaded_by: string | null
        }
        Insert: {
          audio_end_seconds?: number | null
          audio_start_seconds?: number | null
          candidate_people?: Json | null
          document_type?: string | null
          family_id?: string | null
          file_path: string
          filename?: string | null
          id?: string
          interview_summary?: string | null
          interviewee_person_id?: string | null
          kind?: string | null
          parent_document_id?: string | null
          recorded_at?: string | null
          status?: string
          transcription_raw?: string | null
          uploaded_by?: string | null
        }
        Update: {
          audio_end_seconds?: number | null
          audio_start_seconds?: number | null
          candidate_people?: Json | null
          document_type?: string | null
          family_id?: string | null
          file_path?: string
          filename?: string | null
          id?: string
          interview_summary?: string | null
          interviewee_person_id?: string | null
          kind?: string | null
          parent_document_id?: string | null
          recorded_at?: string | null
          status?: string
          transcription_raw?: string | null
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "documents_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_interviewee_person_id_fkey"
            columns: ["interviewee_person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_parent_document_id_fkey"
            columns: ["parent_document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "documents_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "contributors"
            referencedColumns: ["id"]
          },
        ]
      }
      event_people: {
        Row: {
          event_id: string
          person_id: string
          role: string | null
        }
        Insert: {
          event_id: string
          person_id: string
          role?: string | null
        }
        Update: {
          event_id?: string
          person_id?: string
          role?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "event_people_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "event_people_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      events: {
        Row: {
          created_at: string | null
          date_estimate: string | null
          event_type: string | null
          family_id: string | null
          id: string
          location: string | null
          notes: string | null
        }
        Insert: {
          created_at?: string | null
          date_estimate?: string | null
          event_type?: string | null
          family_id?: string | null
          id?: string
          location?: string | null
          notes?: string | null
        }
        Update: {
          created_at?: string | null
          date_estimate?: string | null
          event_type?: string | null
          family_id?: string | null
          id?: string
          location?: string | null
          notes?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "events_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
        ]
      }
      facts: {
        Row: {
          confidence: string | null
          contributor_id: string | null
          document_id: string | null
          family_id: string | null
          field: string
          id: string
          person_id: string | null
          recorded_at: string | null
          source_ref: string | null
          source_type: string
          value: string
        }
        Insert: {
          confidence?: string | null
          contributor_id?: string | null
          document_id?: string | null
          family_id?: string | null
          field: string
          id?: string
          person_id?: string | null
          recorded_at?: string | null
          source_ref?: string | null
          source_type: string
          value: string
        }
        Update: {
          confidence?: string | null
          contributor_id?: string | null
          document_id?: string | null
          family_id?: string | null
          field?: string
          id?: string
          person_id?: string | null
          recorded_at?: string | null
          source_ref?: string | null
          source_type?: string
          value?: string
        }
        Relationships: [
          {
            foreignKeyName: "facts_contributor_id_fkey"
            columns: ["contributor_id"]
            isOneToOne: false
            referencedRelation: "contributors"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "facts_document_id_fkey"
            columns: ["document_id"]
            isOneToOne: false
            referencedRelation: "documents"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "facts_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "facts_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      families: {
        Row: {
          created_at: string | null
          created_by: string | null
          id: string
          name: string
        }
        Insert: {
          created_at?: string | null
          created_by?: string | null
          id?: string
          name: string
        }
        Update: {
          created_at?: string | null
          created_by?: string | null
          id?: string
          name?: string
        }
        Relationships: []
      }
      family_members: {
        Row: {
          family_id: string
          interview_voice_uri: string | null
          joined_at: string | null
          linked_person_id: string | null
          narration_enabled: boolean
          role: string | null
          user_id: string
        }
        Insert: {
          family_id: string
          interview_voice_uri?: string | null
          joined_at?: string | null
          linked_person_id?: string | null
          narration_enabled?: boolean
          role?: string | null
          user_id: string
        }
        Update: {
          family_id?: string
          interview_voice_uri?: string | null
          joined_at?: string | null
          linked_person_id?: string | null
          narration_enabled?: boolean
          role?: string | null
          user_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "family_members_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "family_members_linked_person_id_fkey"
            columns: ["linked_person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
      familysearch_connection: {
        Row: {
          access_token: string
          connected_at: string
          connected_by: string | null
          family_id: string
          fs_display_name: string
          fs_user_id: string
          token_expires_at: string
        }
        Insert: {
          access_token: string
          connected_at?: string
          connected_by?: string | null
          family_id: string
          fs_display_name: string
          fs_user_id: string
          token_expires_at: string
        }
        Update: {
          access_token?: string
          connected_at?: string
          connected_by?: string | null
          family_id?: string
          fs_display_name?: string
          fs_user_id?: string
          token_expires_at?: string
        }
        Relationships: [
          {
            foreignKeyName: "familysearch_connection_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: true
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
        ]
      }
      people: {
        Row: {
          aliases: string | null
          birth_estimate: string | null
          created_at: string | null
          death_estimate: string | null
          family_id: string | null
          first_name: string | null
          gender: string | null
          id: string
          is_placeholder: boolean | null
          is_root: boolean | null
          last_name: string | null
          married_name: string | null
          name: string
          notes: string | null
          preferred_name: string | null
        }
        Insert: {
          aliases?: string | null
          birth_estimate?: string | null
          created_at?: string | null
          death_estimate?: string | null
          family_id?: string | null
          first_name?: string | null
          gender?: string | null
          id?: string
          is_placeholder?: boolean | null
          is_root?: boolean | null
          last_name?: string | null
          married_name?: string | null
          name: string
          notes?: string | null
          preferred_name?: string | null
        }
        Update: {
          aliases?: string | null
          birth_estimate?: string | null
          created_at?: string | null
          death_estimate?: string | null
          family_id?: string | null
          first_name?: string | null
          gender?: string | null
          id?: string
          is_placeholder?: boolean | null
          is_root?: boolean | null
          last_name?: string | null
          married_name?: string | null
          name?: string
          notes?: string | null
          preferred_name?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "people_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
        ]
      }
      photo_tags: {
        Row: {
          person_id: string
          photo_id: string
        }
        Insert: {
          person_id: string
          photo_id: string
        }
        Update: {
          person_id?: string
          photo_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "photo_tags_person_id_fkey"
            columns: ["person_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "photo_tags_photo_id_fkey"
            columns: ["photo_id"]
            isOneToOne: false
            referencedRelation: "photos"
            referencedColumns: ["id"]
          },
        ]
      }
      photos: {
        Row: {
          caption: string | null
          created_at: string | null
          date_estimate: string | null
          event_id: string | null
          family_id: string | null
          file_path: string
          id: string
          uploaded_by: string | null
        }
        Insert: {
          caption?: string | null
          created_at?: string | null
          date_estimate?: string | null
          event_id?: string | null
          family_id?: string | null
          file_path: string
          id?: string
          uploaded_by?: string | null
        }
        Update: {
          caption?: string | null
          created_at?: string | null
          date_estimate?: string | null
          event_id?: string | null
          family_id?: string | null
          file_path?: string
          id?: string
          uploaded_by?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "photos_event_id_fkey"
            columns: ["event_id"]
            isOneToOne: false
            referencedRelation: "events"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "photos_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "photos_uploaded_by_fkey"
            columns: ["uploaded_by"]
            isOneToOne: false
            referencedRelation: "contributors"
            referencedColumns: ["id"]
          },
        ]
      }
      union_children: {
        Row: {
          child_id: string
          union_id: string
        }
        Insert: {
          child_id: string
          union_id: string
        }
        Update: {
          child_id?: string
          union_id?: string
        }
        Relationships: [
          {
            foreignKeyName: "union_children_child_id_fkey"
            columns: ["child_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "union_children_union_id_fkey"
            columns: ["union_id"]
            isOneToOne: false
            referencedRelation: "unions"
            referencedColumns: ["id"]
          },
        ]
      }
      unions: {
        Row: {
          created_at: string | null
          family_id: string | null
          id: string
          note: string | null
          parent1_id: string | null
          parent2_id: string | null
        }
        Insert: {
          created_at?: string | null
          family_id?: string | null
          id?: string
          note?: string | null
          parent1_id?: string | null
          parent2_id?: string | null
        }
        Update: {
          created_at?: string | null
          family_id?: string | null
          id?: string
          note?: string | null
          parent1_id?: string | null
          parent2_id?: string | null
        }
        Relationships: [
          {
            foreignKeyName: "unions_family_id_fkey"
            columns: ["family_id"]
            isOneToOne: false
            referencedRelation: "families"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "unions_parent1_id_fkey"
            columns: ["parent1_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
          {
            foreignKeyName: "unions_parent2_id_fkey"
            columns: ["parent2_id"]
            isOneToOne: false
            referencedRelation: "people"
            referencedColumns: ["id"]
          },
        ]
      }
    }
    Views: {
      [_ in never]: never
    }
    Functions: {
      match_people_by_name: {
        Args: {
          min_similarity?: number
          search_name: string
          target_family_id: string
        }
        Returns: {
          birth_estimate: string
          death_estimate: string
          id: string
          name: string
          similarity: number
        }[]
      }
      show_limit: { Args: never; Returns: number }
      show_trgm: { Args: { "": string }; Returns: string[] }
    }
    Enums: {
      [_ in never]: never
    }
    CompositeTypes: {
      [_ in never]: never
    }
  }
}

type DatabaseWithoutInternals = Omit<Database, "__InternalSupabase">

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
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? (DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Tables"] &
      DatabaseWithoutInternals[DefaultSchemaTableNameOrOptions["schema"]]["Views"])[TableName] extends {
      Row: infer R
    }
    ? R
    : never
  : DefaultSchemaTableNameOrOptions extends keyof (DefaultSchema["Tables"] &
        DefaultSchema["Views"])
    ? (DefaultSchema["Tables"] &
        DefaultSchema["Views"])[DefaultSchemaTableNameOrOptions] extends {
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
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
    : never = never,
> = DefaultSchemaTableNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
    : never = never,
> = DefaultSchemaEnumNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
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
    : never = never,
> = PublicCompositeTypeNameOrOptions extends {
  schema: keyof DatabaseWithoutInternals
}
  ? DatabaseWithoutInternals[PublicCompositeTypeNameOrOptions["schema"]]["CompositeTypes"][CompositeTypeName]
  : PublicCompositeTypeNameOrOptions extends keyof DefaultSchema["CompositeTypes"]
    ? DefaultSchema["CompositeTypes"][PublicCompositeTypeNameOrOptions]
    : never

export const Constants = {
  public: {
    Enums: {},
  },
} as const

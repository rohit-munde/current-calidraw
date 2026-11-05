package com.indiedev.excalinotes;

import jakarta.persistence.*;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;

@Entity
@Table(name = "notes")
public class Note {

    @Id
    @GeneratedValue(strategy = GenerationType.IDENTITY)
    private Long id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "topic_id")
    private Topic topic;

    @Column(nullable = false)
    private String title;

    // The whole Excalidraw scene: elements + appState + files (images as data URLs).
    // Stored as JSONB, so the only limit is your disk.
    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb")
    private String scene;

    @Column(nullable = false)
    private Instant updatedAt = Instant.now();

    protected Note() {
    }

    public Note(Topic topic, String title) {
        this.topic = topic;
        this.title = title;
    }

    @PreUpdate
    void touch() {
        updatedAt = Instant.now();
    }

    public Long getId() { return id; }
    public Topic getTopic() { return topic; }
    public String getTitle() { return title; }
    public void setTitle(String title) { this.title = title; }
    public String getScene() { return scene; }
    public void setScene(String scene) { this.scene = scene; }
    public Instant getUpdatedAt() { return updatedAt; }
}

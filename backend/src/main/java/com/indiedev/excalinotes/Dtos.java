package com.indiedev.excalinotes;

import java.time.Instant;

public final class Dtos {

    private Dtos() {
    }

    public record NameRequest(String name) {
    }

    public record TopicResponse(Long id, String name) {
        static TopicResponse of(Topic t) {
            return new TopicResponse(t.getId(), t.getName());
        }
    }

    public record NoteResponse(Long id, Long topicId, String title, String scene, Instant updatedAt) {
        static NoteResponse of(Note n) {
            return new NoteResponse(n.getId(), n.getTopic().getId(), n.getTitle(), n.getScene(), n.getUpdatedAt());
        }
    }
}

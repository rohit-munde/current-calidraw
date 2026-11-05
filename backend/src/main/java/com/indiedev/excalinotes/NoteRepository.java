package com.indiedev.excalinotes;

import org.springframework.data.jpa.repository.JpaRepository;

import java.time.Instant;
import java.util.List;

public interface NoteRepository extends JpaRepository<Note, Long> {

    // Projection for the list view: only id/title/updatedAt are selected,
    // so the (possibly huge) scene column is never loaded here.
    interface NoteSummary {
        Long getId();
        String getTitle();
        Instant getUpdatedAt();
    }

    List<NoteSummary> findByTopicIdOrderByUpdatedAtDesc(Long topicId);

    void deleteAllByTopicId(Long topicId);
}

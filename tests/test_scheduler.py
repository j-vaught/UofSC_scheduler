"""Regression tests for semester schedule solving."""

import unittest

from scheduler import score_schedule, solve


def section(crn, meeting_times, **overrides):
    result = {
        "crn": crn,
        "code": overrides.pop("code", "TEST 101"),
        "meetingTimes": meeting_times,
        "hours": 3,
    }
    result.update(overrides)
    return result


class SchedulerTests(unittest.TestCase):
    def test_gap_scoring_uses_clock_minutes(self):
        assignment = {
            "TEST 101": {"_parsed_times": [{"day": 0, "start": 900, "end": 950}]},
            "TEST 102": {"_parsed_times": [{"day": 0, "start": 1000, "end": 1050}]},
        }

        score = score_schedule(
            assignment,
            {
                "day_compactness_weight": 0,
                "consecutive_penalty_weight": 2,
                "gap_penalty_weight": 2,
            },
        )

        self.assertEqual(score, -2)

    def test_max_credits_is_a_hard_constraint(self):
        courses = [
            {
                "code": "TEST 101",
                "sections": [section("10001", "[]", meets="Online asynchronous")],
            },
            {
                "code": "TEST 102",
                "sections": [section("10002", "[]", code="TEST 102", meets="Online asynchronous")],
            },
        ]

        too_many = solve({"courses": courses, "preferences": {"max_credits": 5}})
        allowed = solve({"courses": courses, "preferences": {"max_credits": 6}})

        self.assertEqual(too_many["total_found"], 0)
        self.assertEqual(allowed["total_found"], 1)

    def test_explicitly_asynchronous_sections_are_included(self):
        result = solve(
            {
                "courses": [
                    {
                        "code": "TEST 101",
                        "sections": [section("10001", "", meets="Does Not Meet", inst_mthd="DWEB")],
                    }
                ]
            }
        )

        self.assertEqual(result["total_found"], 1)
        self.assertEqual(result["schedules"][0]["sections"]["TEST 101"]["crn"], "10001")

    def test_unscheduled_tba_sections_are_not_assumed_conflict_free(self):
        result = solve(
            {
                "courses": [
                    {
                        "code": "TEST 101",
                        "sections": [section("10001", "", meets="TBA")],
                    }
                ]
            }
        )

        self.assertEqual(result["total_found"], 0)

    def test_minimum_transition_preference_does_not_remove_valid_schedules(self):
        courses = [
            {
                "code": "TEST 101",
                "sections": [
                    section("10001", '[{"meet_day": 0, "start_time": 900, "end_time": 1000}]')
                ],
            },
            {
                "code": "TEST 102",
                "sections": [
                    section(
                        "10002",
                        '[{"meet_day": 0, "start_time": 1010, "end_time": 1100}]',
                        code="TEST 102",
                    )
                ],
            },
        ]

        result = solve({"courses": courses, "preferences": {"minimum_walking_buffer_minutes": 15}})

        self.assertEqual(result["total_found"], 1)

    def test_avoided_days_rank_lower_without_removing_schedules(self):
        courses = [
            {
                "code": "TEST 101",
                "sections": [
                    section("monday", '[{"meet_day": 0, "start_time": 900, "end_time": 1000}]'),
                    section("tuesday", '[{"meet_day": 1, "start_time": 900, "end_time": 1000}]'),
                ],
            }
        ]

        result = solve({"courses": courses, "preferences": {"avoided_days": [0]}})

        self.assertEqual(result["total_found"], 2)
        self.assertEqual(result["schedules"][0]["sections"]["TEST 101"]["crn"], "tuesday")

    def test_minimum_walking_buffer_ranks_without_removing_schedule(self):
        first = section(
            "first",
            '[{"meet_day": 0, "start_time": 900, "end_time": 1000}]',
            _walking_locations=[{"day": 0, "start": 540, "latitude": 34.0, "longitude": -81.0}],
        )
        second = section(
            "far",
            '[{"meet_day": 0, "start_time": 1015, "end_time": 1100}]',
            code="TEST 102",
            _walking_locations=[{"day": 0, "start": 615, "latitude": 34.0, "longitude": -80.99}],
        )

        result = solve(
            {
                "courses": [
                    {"code": "TEST 101", "sections": [first]},
                    {"code": "TEST 102", "sections": [second]},
                ],
                "preferences": {"minimum_walking_buffer_minutes": 5},
            }
        )

        self.assertEqual(result["total_found"], 1)
        self.assertLess(result["schedules"][0]["score"], -30)

    def test_shorter_walks_rank_higher_by_default(self):
        origin = section(
            "origin",
            '[{"meet_day": 0, "start_time": 900, "end_time": 1000}]',
            _walking_locations=[{"day": 0, "start": 540, "latitude": 34.0, "longitude": -81.0}],
        )
        nearby = section(
            "nearby",
            '[{"meet_day": 0, "start_time": 1030, "end_time": 1100}]',
            code="TEST 102",
            _walking_locations=[{"day": 0, "start": 630, "latitude": 34.0, "longitude": -80.999}],
        )
        distant = section(
            "distant",
            '[{"meet_day": 0, "start_time": 1030, "end_time": 1100}]',
            code="TEST 102",
            _walking_locations=[{"day": 0, "start": 630, "latitude": 34.0, "longitude": -80.99}],
        )

        result = solve(
            {
                "courses": [
                    {"code": "TEST 101", "sections": [origin]},
                    {"code": "TEST 102", "sections": [distant, nearby]},
                ],
            }
        )

        self.assertEqual(result["total_found"], 2)
        self.assertEqual(result["schedules"][0]["sections"]["TEST 102"]["crn"], "nearby")

    def test_route_ranking_uses_worst_transition_instead_of_total_travel(self):
        origin = {"day": 0, "start": 900, "end": 1000, "latitude": 34.0, "longitude": -81.0}
        destination = {
            "day": 0,
            "start": 1020,
            "end": 1100,
            "latitude": 34.0,
            "longitude": -80.99,
        }
        single_route = {
            "A": {"_parsed_times": [origin]},
            "B": {"_parsed_times": [destination]},
        }
        repeated_routes = {
            "A": {"_parsed_times": [origin]},
            "B": {"_parsed_times": [destination]},
            "C": {
                "_parsed_times": [
                    {
                        "day": 0,
                        "start": 1120,
                        "end": 1200,
                        "latitude": 34.0,
                        "longitude": -81.0,
                    }
                ]
            },
            "D": {
                "_parsed_times": [
                    {
                        "day": 0,
                        "start": 1220,
                        "end": 1300,
                        "latitude": 34.0,
                        "longitude": -80.99,
                    }
                ]
            },
        }

        single_score = score_schedule(single_route, {})
        repeated_score = score_schedule(repeated_routes, {})

        self.assertEqual(single_score, repeated_score)


if __name__ == "__main__":
    unittest.main()

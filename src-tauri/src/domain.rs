use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct BoardSnapshot {
    pub tasks: Vec<MotherTask>,
    pub view_settings: ViewSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct MotherTask {
    pub id: String,
    pub name: String,
    pub expanded: bool,
    pub sort_order: i64,
    pub depends_on: Vec<String>,
    pub sub_tasks: Vec<SubTask>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SubTask {
    pub id: String,
    pub mother_task_id: String,
    pub name: String,
    pub start_date: String,
    pub end_date: Option<String>,
    pub sort_order: i64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ViewMode {
    Week,
    Biweek,
    Month,
}

impl ViewMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Week => "week",
            Self::Biweek => "biweek",
            Self::Month => "month",
        }
    }

    pub fn parse(value: &str) -> Option<Self> {
        match value {
            "week" => Some(Self::Week),
            "biweek" => Some(Self::Biweek),
            "month" => Some(Self::Month),
            _ => None,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ViewSettings {
    pub view_mode: ViewMode,
    pub anchor_date: String,
    pub show_dependencies: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateMotherTaskInput {
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RenameMotherTaskInput {
    pub id: String,
    pub name: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetMotherExpandedInput {
    pub id: String,
    pub expanded: bool,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderMotherTasksInput {
    pub ordered_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ReorderSubTasksInput {
    pub mother_id: String,
    pub ordered_ids: Vec<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateSubTaskInput {
    pub mother_task_id: String,
    pub name: String,
    pub start_date: String,
    pub end_date: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UpdateSubTaskInput {
    pub id: String,
    pub name: String,
    pub start_date: String,
    pub end_date: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SetDependenciesInput {
    pub task_id: String,
    pub depends_on: Vec<String>,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_the_frontend_contract_with_camel_case_keys() {
        let sub_task = SubTask {
            id: "subtask_1".to_owned(),
            mother_task_id: "task_1".to_owned(),
            name: "Contract test".to_owned(),
            start_date: "2026-09-17".to_owned(),
            end_date: None,
            sort_order: 0,
        };

        let value = serde_json::to_value(sub_task).expect("serialize sub task");
        assert_eq!(value["motherTaskId"], "task_1");
        assert_eq!(value["startDate"], "2026-09-17");
        assert!(value.get("mother_task_id").is_none());
    }
}
